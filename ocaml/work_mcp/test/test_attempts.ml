(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Attempts: the [attempt] event, its fold and the work_attempt tool. *)

open Work_client
module W = Mesh_worklog
module A = Work_mcp.Work_attempts

let int_of j k = match member k j with `Int n -> n | v -> Alcotest.failf "missing int %s: %s" k (Yojson.Safe.to_string v)
let library_ctx ?(host = "owner-ui") wl_home = W.Ctx.make ~root:wl_home ~host ~commit:false ()

let attempt_args ?(extra = []) task outcome =
  `Assoc ([ ("task", `String task); ("outcome", `String outcome) ] @ extra)

let failure ?(reason = "ci_failure") ?(extra = []) task =
  attempt_args task "failure" ~extra:(("reason", `String reason) :: extra)

let new_task c = str (ok c "work_add_task" (`Assoc [ ("title", `String "A"); ("product", `String "gateway") ])) "id"
let attempt_events wl_home = List.filter (fun l -> contains l "\"type\":\"attempt\"") (event_lines wl_home)

let test_lifecycle () =
  with_server (fun c wl_home ->
      let task = new_task c in
      let first =
        ok c "work_attempt"
          (failure task
             ~extra:
               [
                 ("text", `String "the token test is red in CI");
                 ("links", `List [ `String "https://example.invalid/runs/1" ]);
                 ("started", `String "2026-01-01T10:00:00Z");
                 ("ended", `String "2026-01-01T11:00:00Z");
                 ("ref", `String "lib-pr:1");
               ])
      in
      Alcotest.(check bool) "A- id" true (A.valid_id (str first "id"));
      Alcotest.(check int) "first attempt" 1 (int_of first "n");
      Alcotest.(check int) "one consecutive failure" 1 (int_of first "consecutive_failures");
      ignore (ok c "work_attempt" (failure ~reason:"test_red" task));
      let third = ok c "work_attempt" (failure ~reason:"review_nogo" task) in
      Alcotest.(check int) "third" 3 (int_of third "n");
      Alcotest.(check bool) "reframe flagged" true (member "needs_reframe" third = `Bool true);
      let got = member "attempts" (ok c "work_get" (`Assoc [ ("id", `String task) ])) in
      Alcotest.(check int) "total" 3 (int_of got "total");
      Alcotest.(check int) "consecutive" 3 (int_of got "consecutive_failures");
      Alcotest.(check int) "threshold" 3 (int_of got "consecutive_failures_threshold");
      Alcotest.(check string) "last reason" "review_nogo" (str (member "last" got) "reason");
      Alcotest.(check string) "last outcome" "failure" (str (member "last" got) "outcome");
      let fourth = ok c "work_attempt" (attempt_args task "success") in
      Alcotest.(check int) "a success resets the run" 0 (int_of fourth "consecutive_failures");
      let got = ok c "work_get" (`Assoc [ ("id", `String task) ]) in
      let summary = member "attempts" got in
      Alcotest.(check int) "four attempts" 4 (int_of summary "total");
      Alcotest.(check int) "three failures" 3 (int_of summary "failures");
      Alcotest.(check bool) "no reframe" true (member "needs_reframe" summary = `Bool false);
      Alcotest.(check bool) "no reason on success" true (member "reason" (member "last" summary) = `Null);
      Alcotest.(check bool) "the session is linked" true
        (contains (Yojson.Safe.to_string (member "sessions" got)) "probe-session");
      let row = List.hd (items (ok c "work_list_tasks" (`Assoc [])) "tasks") in
      Alcotest.(check int) "the list row counts attempts" 4 (int_of row "attempts");
      (* The number is never stored. *)
      Alcotest.(check bool) "no stored number" false
        (List.exists (fun l -> contains l "\"n\":") (attempt_events wl_home));
      Alcotest.(check int) "four events" 4 (List.length (attempt_events wl_home)))

let test_no_attempts () =
  with_server (fun c _ ->
      let task = new_task c in
      let got = member "attempts" (ok c "work_get" (`Assoc [ ("id", `String task) ])) in
      Alcotest.(check int) "zero" 0 (int_of got "total");
      Alcotest.(check bool) "no last" true (member "last" got = `Null);
      let row = List.hd (items (ok c "work_list_tasks" (`Assoc [])) "tasks") in
      Alcotest.(check bool) "list rows stay as before" true (member "attempts" row = `Null))

let test_refused () =
  with_server (fun c wl_home ->
      let task = new_task c in
      let project = str (ok c "work_add_project" (`Assoc [ ("title", `String "P"); ("product", `String "gateway") ])) "id" in
      let before = List.length (event_lines wl_home) in
      let refused what args =
        let r = call c "work_attempt" args in
        if not r.is_error then Alcotest.failf "%s was accepted" what
      in
      refused "a failure without a reason" (attempt_args task "failure");
      refused "an unknown reason" (failure ~reason:"flaky" task);
      refused "an unknown outcome" (attempt_args task "failed");
      refused "a success with a reason" (attempt_args task "success" ~extra:[ ("reason", `String "other") ]);
      refused "a text over 500 characters" (failure task ~extra:[ ("text", `String (String.make 501 'x')) ]);
      refused "a text on two lines" (failure task ~extra:[ ("text", `String "a\nb") ]);
      refused "a blank text" (failure task ~extra:[ ("text", `String "   ") ]);
      refused "a bidirectional override" (failure task ~extra:[ ("text", `String "a\u{202E}b") ]);
      refused "six links"
        (failure task ~extra:[ ("links", `List (List.init 6 (fun i -> `String (Printf.sprintf "https://e.invalid/%d" i)))) ]);
      refused "a link over 300 characters" (failure task ~extra:[ ("links", `List [ `String (String.make 301 'l') ]) ]);
      refused "ended before started"
        (failure task ~extra:[ ("started", `String "2026-01-02T00:00:00Z"); ("ended", `String "2026-01-01T00:00:00Z") ]);
      refused "a start in the future" (failure task ~extra:[ ("started", `String "2999-01-01T00:00:00Z") ]);
      refused "an end in the future" (failure task ~extra:[ ("ended", `String "2999-01-01T00:00:00Z") ]);
      refused "a malformed timestamp" (failure task ~extra:[ ("started", `String "yesterday") ]);
      refused "a ref outside its alphabet" (failure task ~extra:[ ("ref", `String "a b") ]);
      refused "an unknown task" (failure "T-ffff");
      refused "a project" (failure project);
      refused "an unknown field" (failure task ~extra:[ ("n", `Int 2) ]);
      refused "a stored number" (failure task ~extra:[ ("id", `String "A-0000abcd") ]);
      Alcotest.(check int) "nothing written" before (List.length (event_lines wl_home)))

(* The library checks every rule itself: a writer that does not go through
   the tool's schema gets the same refusals. *)
let test_library_rules () =
  with_server (fun c wl_home ->
      let task = new_task c in
      let ctx = library_ctx wl_home in
      let refused what r = Alcotest.(check bool) what true (Result.is_error r) in
      refused "no reason" (A.record ctx ~task ~outcome:"failure" ());
      refused "bad reason" (A.record ctx ~task ~outcome:"failure" ~reason:"x" ());
      refused "reason on success" (A.record ctx ~task ~outcome:"success" ~reason:"other" ());
      refused "long text" (A.record ctx ~task ~outcome:"abandoned" ~text:(String.make 501 'x') ());
      refused "zero-width" (A.record ctx ~task ~outcome:"abandoned" ~text:"a\u{200B}b" ());
      refused "too many links" (A.record ctx ~task ~outcome:"abandoned" ~links:(List.init 6 string_of_int) ());
      refused "ref" (A.record ctx ~task ~outcome:"abandoned" ~ref_:(String.make 65 'r') ());
      refused "request id" (A.record ctx ~task ~outcome:"abandoned" ~request_id:"a/b" ());
      let r = W.Err.unwrap (A.record ctx ~task ~outcome:"abandoned" ()) in
      Alcotest.(check int) "abandoned needs no reason" 1 r.number;
      Alcotest.(check int) "abandoned is no failure" 0 r.task_summary.consecutive_failures)

let test_request_id () =
  with_server (fun c wl_home ->
      let task = new_task c and other = new_task c in
      let keyed t = failure t ~extra:[ ("request_id", `String "retry-1") ] in
      let first = ok c "work_attempt" (keyed task) in
      let again = ok c "work_attempt" (keyed task) in
      Alcotest.(check string) "same id" (str first "id") (str again "id");
      Alcotest.(check bool) "duplicate" true (member "duplicate" again = `Bool true);
      Alcotest.(check int) "same number" 1 (int_of again "n");
      ignore (ok c "work_attempt" (keyed other));
      Alcotest.(check int) "another task writes" 2 (List.length (attempt_events wl_home));
      let home = Filename.dirname wl_home in
      let anonymous = connect ~session:"" ~wl_home ~home () in
      Fun.protect ~finally:(fun () -> stop anonymous) (fun () ->
          Alcotest.(check bool) "a request_id needs a session" true (call anonymous "work_attempt" (keyed task)).is_error))

let test_no_noise () =
  with_server (fun c _ ->
      let task = new_task c in
      ignore (ok c "work_attempt" (failure task));
      ignore (ok c "work_attempt" (attempt_args task "success"));
      List.iter
        (fun (name, args) ->
          let r = ok c name args in
          Alcotest.(check bool) (name ^ ": no data_warnings") true (member "data_warnings" r = `Null))
        [
          ("work_get", `Assoc [ ("id", `String task) ]);
          ("work_list_tasks", `Assoc []);
          ("work_resume", `Assoc []);
          ("work_list_questions", `Assoc []);
        ])

let event ?(host = "hosta") ?(line = 1) ts task fields =
  let data = [ ("ts", `String ts); ("task", `String task); ("type", `String "attempt") ] @ fields in
  {
    W.Event.ts = Option.get (W.Tstamp.parse ts);
    task;
    typ = "attempt";
    data;
    host;
    file = "2026-11." ^ host ^ ".jsonl";
    line;
  }

let fields id outcome reason =
  [ ("id", `String id); ("outcome", `String outcome) ]
  @ match reason with Some r -> [ ("reason", `String r) ] | None -> []

(* The number follows the fold order (time, then host), per task; an
   abandoned pass leaves the run of failures as it was; a success resets it. *)
let test_fold () =
  let events =
    List.stable_sort W.Event.compare
      [
        event "2026-11-01T10:00:00Z" "T-1111" (fields "A-00000001" "failure" (Some "ci_failure"));
        event ~host:"hostb" "2026-11-01T10:00:00Z" "T-1111" (fields "A-00000002" "failure" (Some "test_red"));
        event "2026-11-01T10:00:00Z" "T-2222" (fields "A-00000003" "success" None);
        event "2026-11-01T11:00:00Z" "T-1111" (fields "A-00000004" "abandoned" None);
        event "2026-11-01T12:00:00Z" "T-1111" (fields "A-00000005" "failure" (Some "external"));
      ]
  in
  let all, warnings = A.of_events_report events in
  Alcotest.(check (list string)) "no warning" [] warnings;
  let mine = A.of_task "T-1111" all in
  Alcotest.(check (list int)) "derived numbers" [ 1; 2; 3; 4 ] (List.map (fun (a : A.attempt) -> a.n) mine);
  Alcotest.(check (list string)) "host order breaks a tie" [ "A-00000001"; "A-00000002"; "A-00000004"; "A-00000005" ]
    (List.map (fun (a : A.attempt) -> a.id) mine);
  let s = A.summary mine in
  Alcotest.(check int) "abandoned does not break the run" 3 s.consecutive_failures;
  Alcotest.(check bool) "flagged" true (A.needs_reframe s);
  Alcotest.(check int) "other task" 1 (List.length (A.of_task "T-2222" all));
  let reset = A.summary (mine @ [ { (List.hd mine) with outcome = "success"; reason = None } ]) in
  Alcotest.(check int) "success resets" 0 reset.consecutive_failures

let test_malformed () =
  let events =
    [
      event "2026-11-01T10:00:00Z" "T-1111" (fields "A-00000001" "failure" (Some "ci_failure"));
      event ~line:2 "2026-11-01T10:00:01Z" "T-1111" (fields "A-00000001" "success" None);
      event ~line:3 "2026-11-01T10:00:02Z" "T-1111" (fields "X-1" "success" None);
      event ~line:4 "2026-11-01T10:00:03Z" "T-1111" (fields "A-00000009" "won" None);
      event ~line:5 "2026-11-01T10:00:04Z" "T-1111" (fields "A-0000000a" "failure" None);
    ]
  in
  let all, warnings = A.of_events_report events in
  Alcotest.(check int) "one usable attempt" 1 (List.length all);
  Alcotest.(check int) "four warnings" 4 (List.length warnings);
  Alcotest.(check bool) "the collision is named" true (List.exists (fun w -> contains w "A-00000001") warnings)

(* The worklog library, which is wl's format, still folds a repository with
   attempts: the event is reported as unknown, stays in the raw events and
   does not enter the task's timeline. *)
let test_library_compatible () =
  with_server (fun c wl_home ->
      let task = new_task c in
      ignore (ok c "work_attempt" (failure task));
      let snap = W.Err.unwrap (W.Reader.snapshot (library_ctx wl_home)) in
      Alcotest.(check bool) "warned as unknown" true
        (List.exists (fun w -> contains w "unknown event type \"attempt\"") snap.warnings);
      Alcotest.(check bool) "every such warning is noise" true
        (List.for_all (fun w -> (not (contains w "\"attempt\"")) || A.is_noise w) snap.warnings);
      Alcotest.(check int) "kept in the raw events" 1
        (List.length (List.filter (fun (e : W.Event.t) -> e.typ = "attempt") snap.loaded.events));
      let t = W.Model.Smap.find task snap.loaded.world.tasks in
      Alcotest.(check bool) "not in the timeline" false
        (List.exists (fun (e : W.Event.t) -> e.typ = "attempt") t.timeline))

let tests =
  [
    Alcotest.test_case "attempt lifecycle" `Quick test_lifecycle;
    Alcotest.test_case "a task without attempts" `Quick test_no_attempts;
    Alcotest.test_case "refused inputs" `Quick test_refused;
    Alcotest.test_case "library rules" `Quick test_library_rules;
    Alcotest.test_case "request_id retries" `Quick test_request_id;
    Alcotest.test_case "no warning noise" `Quick test_no_noise;
    Alcotest.test_case "fold order and runs" `Quick test_fold;
    Alcotest.test_case "malformed events reported" `Quick test_malformed;
    Alcotest.test_case "the worklog library still folds" `Quick test_library_compatible;
  ]
