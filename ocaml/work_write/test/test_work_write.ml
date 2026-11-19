(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Ww_runner
module U = Yojson.Safe.Util
module Q = Work_mcp.Work_questions
module W = Mesh_worklog

let member key j = U.member key j
let str key j = U.to_string (member key j)
let flag key j = match member key j with `Bool b -> b | _ -> false
let code_of r = str "code" (member "error" (json r))

let ok repo input =
  let r = run repo input in
  if r.code <> 0 then Alcotest.failf "exit %d: %s" r.code r.out;
  json r

let question repo id = List.find (fun q -> str "id" q = id) (questions repo)
let answers repo id = U.to_list (member "answers" (question repo id))

let relayed_line ?(extra = "") id text =
  Printf.sprintf
    {|{"ts":"2026-11-08T10:00:00Z","task":"T-3c4d","type":"answer","question":"%s","text":"%s","by":"owner","agent":"claude","session":"asking"%s}|}
    id text extra

let test_answer_recorded () =
  let repo = fixture () in
  let doc = ok repo (request (qid 0) "Use port 8443") in
  Alcotest.(check string) "id" (qid 0) (str "id" doc);
  Alcotest.(check bool) "owner_verified" true (flag "owner_verified" doc);
  Alcotest.(check bool) "not a duplicate" false (flag "duplicate" doc);
  (match answer_events repo with
  | [ `Assoc fields ] ->
      Alcotest.(check (list string)) "the event's fields" [ "ts"; "task"; "type"; "question"; "text"; "by"; "via" ]
        (List.map fst fields);
      Alcotest.(check bool) "via owner-web" true (List.assoc "via" fields = `String Q.owner_web_via);
      Alcotest.(check bool) "by owner" true (List.assoc "by" fields = `String "owner")
  | events -> Alcotest.failf "one answer event expected, got %d" (List.length events));
  let q = question repo (qid 0) in
  Alcotest.(check string) "answered" "answered" (str "state" q);
  (match U.to_list (member "answers" q) with
  | [ a ] ->
      Alcotest.(check bool) "read back as verified" true (flag "owner_verified" a);
      Alcotest.(check bool) "no relay" true (member "relayed_by_session" a = `Null)
  | _ -> Alcotest.fail "one answer");
  Alcotest.(check string) "the other question stays open" "open" (str "state" (question repo (qid 1)))

let test_duplicate_and_conflict () =
  let repo = fixture () in
  ignore (ok repo (request (qid 0) "yes"));
  Alcotest.(check bool) "the same answer is a duplicate" true (flag "duplicate" (ok repo (request (qid 0) "yes")));
  let r = run repo (request (qid 0) "no") in
  Alcotest.(check int) "another answer: exit 8" 8 r.code;
  Alcotest.(check string) "already_answered" "already_answered" (code_of r);
  Alcotest.(check int) "one event written" 1 (List.length (answer_events repo));
  let missing = run repo (request "N-0000ffff" "x") in
  Alcotest.(check int) "unknown question: exit 3" 3 missing.code;
  Alcotest.(check string) "not_found" "not_found" (code_of missing)

(* A relayed (possibly forged) answer does not lock the owner out: the owner's
   answer supersedes it, and the relayed one stays in the history. *)
let test_supersedes_relayed () =
  let repo = fixture ~lines:[ relayed_line (qid 0) "forged by an agent" ] () in
  let doc = ok repo (request (qid 0) "the real answer") in
  Alcotest.(check bool) "recorded, not a duplicate" false (flag "duplicate" doc);
  (match answers repo (qid 0) with
  | [ relayed; owner ] ->
      Alcotest.(check string) "relayed text kept" "forged by an agent" (str "text" relayed);
      Alcotest.(check bool) "relayed marked superseded" true (flag "superseded" relayed);
      Alcotest.(check bool) "relayed not verified" false (flag "owner_verified" relayed);
      Alcotest.(check bool) "owner verified" true (flag "owner_verified" owner);
      Alcotest.(check bool) "owner not superseded" false (flag "superseded" owner)
  | l -> Alcotest.failf "two answers expected, got %d" (List.length l));
  let same_as_relayed = fixture ~lines:[ relayed_line (qid 0) "yes" ] () in
  Alcotest.(check bool) "the owner confirming the relayed text is written" false
    (flag "duplicate" (ok same_as_relayed (request (qid 0) "yes")));
  Alcotest.(check int) "two events" 2 (List.length (answer_events same_as_relayed))

(* After the owner's answer, the relayed path (work_answer) is refused. *)
let test_relay_after_owner () =
  let repo = fixture () in
  ignore (ok repo (request (qid 0) "owner says yes"));
  let ctx = W.Ctx.make ~root:repo.wl_home ~host:"agent" ~commit:false () in
  Alcotest.(check bool) "relayed answer refused" true
    (W.Err.unwrap (Q.answer_once ctx ~question:(qid 0) ~text:"agent says no" ~by:"owner" ()) = Q.Already_answered (qid 0));
  let session = W.Err.unwrap (W.Session.make ~agent:"claude" ~session:"s1" ()) in
  let refused =
    match Q.answer_once ctx ~session ~owner_web:true ~question:(qid 1) ~text:"x" ~by:"owner" () with
    | Error { kind = W.Err.Usage; _ } -> true
    | _ -> false
  in
  Alcotest.(check bool) "owner_web with a session is refused" true refused;
  let not_owner =
    match Q.answer_once ctx ~owner_web:true ~question:(qid 1) ~text:"x" ~by:"someone" () with
    | Error { kind = W.Err.Usage; _ } -> true
    | _ -> false
  in
  Alcotest.(check bool) "owner_web by someone else is refused" true not_owner

(* Lines that claim the marker without fitting it are not verified. *)
let test_forged_marker () =
  let forged_relay = relayed_line ~extra:{|,"via":"owner-web"|} (qid 0) "marker with a session" in
  let forged_by =
    Printf.sprintf {|{"ts":"2026-11-08T10:00:00Z","task":"T-3c4d","type":"answer","question":"%s","text":"x","by":"admin","via":"owner-web"}|}
      (qid 1)
  in
  let repo = fixture ~lines:[ forged_relay; forged_by ] () in
  List.iter
    (fun id ->
      match answers repo id with
      | [ a ] -> Alcotest.(check bool) (id ^ " not verified") false (flag "owner_verified" a)
      | _ -> Alcotest.fail "one answer")
    [ qid 0; qid 1 ];
  Alcotest.(check bool) "the owner can still answer" false (flag "duplicate" (ok repo (request (qid 0) "real")))

let test_concurrent_writers () =
  let n = 12 in
  let repo = fixture ~questions:n () in
  let waits =
    List.concat_map
      (fun i -> [ spawn repo (request (qid i) "first"); spawn repo (request (qid i) "second") ])
      (List.init n Fun.id)
  in
  let results = List.map (fun wait -> wait ()) waits in
  let recorded = List.filter (fun r -> r.code = 0 && not (flag "duplicate" (json r))) results in
  let conflicts = List.filter (fun r -> r.code = 8) results in
  Alcotest.(check int) "one answer recorded per question" n (List.length recorded);
  Alcotest.(check int) "the other refused" n (List.length conflicts);
  Alcotest.(check int) "no event lost or doubled" n (List.length (answer_events repo));
  List.iter
    (fun i -> Alcotest.(check int) (qid i ^ " one answer") 1 (List.length (answers repo (qid i))))
    (List.init n Fun.id)

let test_agent_session_refused () =
  let repo = fixture () in
  List.iter
    (fun name ->
      let r = run ~env:[ (name, "x") ] repo (request (qid 0) "yes") in
      Alcotest.(check int) (name ^ ": exit 9") 9 r.code;
      Alcotest.(check string) (name ^ ": code") "agent_session" (code_of r))
    Work_write.Ww_cmd.session_variables;
  Alcotest.(check int) "an empty value is unset" 0 (run ~env:[ ("MESH_SESSION", "") ] repo (request (qid 1) "y")).code;
  Alcotest.(check int) "only the last answer written" 1 (List.length (answer_events repo))

let test_missing_repository () =
  let root = temp_dir "work-write-none" in
  let repo = { home = Filename.concat root "home"; wl_home = Filename.concat root "nothing" } in
  Unix.mkdir repo.home 0o700;
  let before = tree_state root in
  let r = run repo (request (qid 0) "yes") in
  Alcotest.(check int) "exit 6" 6 r.code;
  Alcotest.(check string) "repository" "repository" (code_of r);
  Alcotest.(check bool) "nothing created" true (before = tree_state root);
  Alcotest.(check bool) "no path in the message" false
    (let out = r.out in
     let n = String.length root in
     let rec at i = i + n <= String.length out && (String.sub out i n = root || at (i + 1)) in
     at 0)

let () =
  Alcotest.run "work-write"
    [
      ( "answer",
        [
          Alcotest.test_case "recorded as owner-authenticated" `Quick test_answer_recorded;
          Alcotest.test_case "duplicate and conflict" `Quick test_duplicate_and_conflict;
          Alcotest.test_case "supersedes a relayed answer" `Quick test_supersedes_relayed;
          Alcotest.test_case "relay refused after the owner" `Quick test_relay_after_owner;
          Alcotest.test_case "forged markers are not verified" `Quick test_forged_marker;
          Alcotest.test_case "concurrent writers" `Quick test_concurrent_writers;
          Alcotest.test_case "agent session refused" `Quick test_agent_session_refused;
          Alcotest.test_case "missing repository" `Quick test_missing_repository;
        ] );
      ("hostile input", Test_hostile.tests);
    ]
