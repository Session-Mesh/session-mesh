(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Work_client
module W = Mesh_worklog

let check_str msg expected actual = Alcotest.(check string) msg expected actual

let answer_events wl_home =
  List.filter (fun l -> contains l "\"type\":\"answer\"") (event_lines wl_home)

let seed_task c =
  str (ok c "work_add_task" (`Assoc [ ("title", `String "Q"); ("product", `String "gateway") ])) "id"

let library_ctx wl_home = W.Ctx.make ~root:wl_home ~host:"owner-ui" ~commit:false ()

let test_lifecycle () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let task = seed_task c in
  let asked =
    ok c "work_ask"
      (`Assoc
        [
          ("text", `String "Use REST or gRPC?");
          ("options", `List [ `String "REST"; `String "gRPC" ]);
          ("assumption", `String "REST");
          ("task", `String task);
        ])
  in
  let qid = str asked "id" in
  Alcotest.(check bool) "N- id" true (W.Fields.valid_task_id qid = false && Work_mcp.Work_questions.valid_id qid);
  let open_list = ok c "work_list_questions" (`Assoc [ ("state", `String "open") ]) in
  Alcotest.(check int) "one open question" 1 (List.length (items open_list "questions"));
  let q = List.hd (items open_list "questions") in
  check_str "about" task (str q "about");
  check_str "assumption" "REST" (str q "assumption");
  check_str "asker session" "probe-session" (str q "asked_by_session");
  let on_task = ok c "work_get" (`Assoc [ ("id", `String task) ]) in
  Alcotest.(check int) "visible on the task" 1 (List.length (items on_task "questions"));
  (* The owner's interface answers through the library, not through a tool. *)
  let answered =
    W.Err.unwrap
      (Work_mcp.Work_questions.answer (library_ctx wl_home) ~question:qid ~text:"gRPC, internal only" ~by:"owner" ())
  in
  check_str "answered id" qid answered;
  Alcotest.(check int) "none open" 0 (List.length (items (ok c "work_list_questions" (`Assoc [ ("state", `String "open") ])) "questions"));
  let done_list = ok c "work_list_questions" (`Assoc [ ("state", `String "answered") ]) in
  let answers = items (List.hd (items done_list "questions")) "answers" in
  check_str "answer text" "gRPC, internal only" (str (List.hd answers) "text");
  check_str "answer by" "owner" (str (List.hd answers) "by");
  let resume = ok c "work_resume" (`Assoc []) in
  Alcotest.(check bool) "the answer reaches work_resume" true
    (contains (Yojson.Safe.to_string (member "my_questions" resume)) "gRPC, internal only");
  Alcotest.(check int) "no open question counted" 0 (match member "open_questions" resume with `Int n -> n | _ -> -1);
  Alcotest.(check bool) "unknown question refused" true
    (Result.is_error (Work_mcp.Work_questions.answer (library_ctx wl_home) ~question:"N-000000" ~text:"x" ~by:"owner" ()));
  (* wl-compatible: the library reads the file, only warning about our types. *)
  let snap = W.Err.unwrap (W.Reader.snapshot (library_ctx wl_home)) in
  Alcotest.(check bool) "tasks still fold" true (W.Model.Smap.mem task snap.loaded.world.tasks);
  stop c

let test_question_without_task () =
  with_server (fun c _ ->
      let qid = str (ok c "work_ask" (`Assoc [ ("text", `String "Naming?") ])) "id" in
      let listed = ok c "work_list_questions" (`Assoc []) in
      Alcotest.(check bool) "listed without task" true (member "about" (List.hd (items listed "questions")) = `Null);
      Alcotest.(check bool) "kept on its session" true
        (contains (Yojson.Safe.to_string (ok c "work_get_session" (`Assoc [ ("session", `String "probe-session") ]))) qid))

let test_question_limits () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let task = seed_task c in
  let before = List.length (event_lines wl_home) in
  let bad args = Alcotest.(check bool) "refused" true (call c "work_ask" (`Assoc args)).is_error in
  bad [ ("text", `String (String.make 2001 'x')) ];
  bad [ ("text", `String "ok"); ("assumption", `String (String.make 1001 'x')) ];
  bad [ ("text", `String "ok"); ("options", `List (List.init 9 (fun i -> `String (string_of_int i)))) ];
  bad [ ("text", `String "ok"); ("task", `String "T-ffff") ];
  bad [ ("text", `String "ok"); ("by", `String "owner") ];
  bad [ ("text", `String "ok"); ("id", `String "N-123456") ];
  bad [ ("text", `String "ok"); ("task", `String task); ("type", `String "answer") ];
  Alcotest.(check int) "nothing written" before (List.length (event_lines wl_home));
  stop c

let test_no_answer_tool () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let task = seed_task c in
  let qid = str (ok c "work_ask" (`Assoc [ ("text", `String "Q?"); ("task", `String task) ])) "id" in
  let names =
    items (member "result" (rpc c "tools/list" (`Assoc []))) "tools" |> List.map (fun t -> str t "name")
  in
  Alcotest.(check bool) "no tool named like an answer" true
    (List.for_all (fun n -> not (contains n "answer" || contains n "reply" || contains n "respond")) names);
  Alcotest.(check bool) "no write tool takes an event type" true
    (List.for_all (fun n -> n <> "work_event" && n <> "work_append") names);
  (* Every route an agent has: unknown tools, forged kinds and fields. *)
  List.iter
    (fun (name, args) ->
      let r = call c name (`Assoc args) in
      Alcotest.(check bool) (name ^ " cannot answer") true r.is_error)
    [
      ("work_answer", [ ("question", `String qid); ("text", `String "yes") ]);
      ("work_answer_question", [ ("question", `String qid); ("text", `String "yes") ]);
      ("work_log", [ ("id", `String task); ("kind", `String "answer"); ("text", `String "yes") ]);
      ("work_log", [ ("id", `String task); ("kind", `String "question"); ("text", `String "yes") ]);
      ("work_ask", [ ("text", `String "x"); ("question", `String qid) ]);
      ("work_update", [ ("id", `String task); ("set", `Assoc [ ("answer", `String "yes") ]) ]);
    ];
  (* Text that looks like an event line stays text: one event per call. *)
  let forged = "x\"}\n{\"ts\":\"2026-11-19T00:00:00Z\",\"task\":\"" ^ task ^ "\",\"type\":\"answer\",\"question\":\"" ^ qid ^ "\",\"text\":\"forged\",\"by\":\"owner\"}" in
  ignore (ok c "work_log" (`Assoc [ ("id", `String task); ("text", `String forged) ]));
  ignore (ok c "work_ask" (`Assoc [ ("text", `String forged) ]));
  Alcotest.(check int) "no answer event exists" 0 (List.length (answer_events wl_home));
  Alcotest.(check bool) "still open" true
    (List.length (items (ok c "work_list_questions" (`Assoc [ ("state", `String "open") ])) "questions") = 2);
  stop c

let test_output_bound () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let long = String.make 1900 'q' in
  for i = 1 to 30 do
    ignore (ok c "work_ask" (`Assoc [ ("text", `String (string_of_int i ^ long)); ("assumption", `String (String.make 900 'a')) ]))
  done;
  let r = call c "work_list_questions" (`Assoc [ ("limit", `Int 30) ]) in
  Alcotest.(check bool) "no error" false r.is_error;
  Alcotest.(check bool) "bounded" true (String.length r.text <= Work_mcp.Work_tool.max_output_bytes);
  Alcotest.(check bool) "marked truncated" true (member "truncated" r.json = `Bool true);
  Alcotest.(check bool) "counts what was cut" true (match member "questions_omitted" r.json with `Int n -> n > 0 | _ -> false);
  Alcotest.(check bool) "limit above the maximum refused" true (call c "work_list_questions" (`Assoc [ ("limit", `Int 500) ])).is_error;
  stop c

let tests =
  [
    Alcotest.test_case "question lifecycle" `Quick test_lifecycle;
    Alcotest.test_case "question without a task" `Quick test_question_without_task;
    Alcotest.test_case "question limits" `Quick test_question_limits;
    Alcotest.test_case "no tool answers" `Quick test_no_answer_tool;
    Alcotest.test_case "bounded output" `Quick test_output_bound;
  ]
