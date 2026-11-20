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

let ok ?env repo input =
  let r = run ?env repo input in
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
  (* By owner, with the marker and a session but no agent: the session alone disqualifies it. *)
  let forged_session =
    Printf.sprintf
      {|{"ts":"2026-11-08T10:00:00Z","task":"T-3c4d","type":"answer","question":"%s","text":"x","by":"owner","via":"owner-web","session":"asking"}|}
      (qid 2)
  in
  (* By owner, with the marker and an agent but no session: the agent alone disqualifies it. *)
  let forged_agent =
    Printf.sprintf
      {|{"ts":"2026-11-08T10:00:00Z","task":"T-3c4d","type":"answer","question":"%s","text":"x","by":"owner","via":"owner-web","agent":"claude"}|}
      (qid 3)
  in
  let repo = fixture ~questions:4 ~lines:[ forged_relay; forged_by; forged_session; forged_agent ] () in
  List.iter
    (fun id ->
      (match answers repo id with
      | [ a ] -> Alcotest.(check bool) (id ^ " not verified") false (flag "owner_verified" a)
      | _ -> Alcotest.fail "one answer");
      Alcotest.(check bool) (id ^ " not owner_answered") false (flag "owner_answered" (question repo id)))
    [ qid 0; qid 1; qid 2; qid 3 ];
  Alcotest.(check bool) "the owner can answer under the agent-marked line" false
    (flag "duplicate" (ok repo (request (qid 3) "real")));
  Alcotest.(check bool) "the owner can still answer" false (flag "duplicate" (ok repo (request (qid 0) "real")))

(* Five later relayed lines (written straight to the log, as a forger would)
   must not push the owner's answer out of the five shown: the view would then
   offer the form again and the owner's send would get already_answered. *)
let test_cap_keeps_owner_answer () =
  let repo = fixture () in
  (* The owner's answer gets a fixed time, before the relayed lines: with the
     wall clock the order would flip once the clock passes them. *)
  let owner_time = "2026-12-01T09:59:00Z" in
  ignore (ok ~env:[ ("WL_NOW", owner_time) ] repo (request (qid 0) "the owner's answer"));
  (match answer_events repo with
  | [ owner ] -> Alcotest.(check string) "the owner's answer has the fixed time" owner_time (str "ts" owner)
  | events -> Alcotest.failf "one answer event expected, got %d" (List.length events));
  let later i =
    Printf.sprintf
      {|{"ts":"2026-12-01T10:0%d:00Z","task":"T-3c4d","type":"answer","question":"%s","text":"relayed %d","by":"owner","agent":"claude","session":"asking"}|}
      i (qid 0) i
  in
  Out_channel.with_open_bin
    (Filename.concat (Filename.concat repo.wl_home "events") "2026-12.hostr.jsonl")
    (fun oc -> output_string oc (String.concat "\n" (List.init 5 later) ^ "\n"));
  let q = question repo (qid 0) in
  Alcotest.(check bool) "the question says the owner answered it" true (flag "owner_answered" q);
  Alcotest.(check int) "one older answer left out" 1 (U.to_int (member "answers_omitted" q));
  match answers repo (qid 0) with
  | owner :: relayed ->
      Alcotest.(check string) "the owner's answer is kept, first in time order" "the owner's answer" (str "text" owner);
      Alcotest.(check bool) "it is verified" true (flag "owner_verified" owner);
      Alcotest.(check (list string)) "then the newest relayed ones" [ "relayed 1"; "relayed 2"; "relayed 3"; "relayed 4" ]
        (List.map (str "text") relayed);
      Alcotest.(check bool) "all superseded" true (List.for_all (flag "superseded") relayed)
  | [] -> Alcotest.fail "answers expected"

(* Two owner-verified answers exist only through forgery or merged histories;
   the cap keeps the latest one, the one the readers report. *)
let test_cap_keeps_latest_owner_answer () =
  let line i text extra =
    Printf.sprintf {|{"ts":"2026-11-08T10:0%d:00Z","task":"T-3c4d","type":"answer","question":"%s","text":"%s","by":"owner"%s}|}
      i (qid 0) text extra
  in
  let owner i text = line i text {|,"via":"owner-web"|} in
  let relayed i = line i (Printf.sprintf "relayed %d" i) {|,"agent":"claude","session":"asking"|} in
  let repo = fixture ~lines:([ owner 0 "older owner answer"; owner 1 "latest owner answer" ] @ List.init 5 (fun i -> relayed (i + 2))) () in
  match answers repo (qid 0) with
  | first :: rest ->
      Alcotest.(check string) "the latest owner answer is kept" "latest owner answer" (str "text" first);
      Alcotest.(check bool) "verified" true (flag "owner_verified" first);
      Alcotest.(check (list string)) "then the newest relayed ones" [ "relayed 3"; "relayed 4"; "relayed 5"; "relayed 6" ]
        (List.map (str "text") rest)
  | [] -> Alcotest.fail "answers expected"

let test_open_question_flag () =
  let repo = fixture ~lines:[ relayed_line (qid 0) "relayed only" ] () in
  Alcotest.(check bool) "a relayed answer alone is not the owner's" false (flag "owner_answered" (question repo (qid 0)));
  Alcotest.(check bool) "an open question neither" false (flag "owner_answered" (question repo (qid 1)))

let git repo args =
  let command = Filename.quote_command "git" ([ "-C"; repo.wl_home; "-c"; "user.name=t"; "-c"; "user.email=t@example.invalid" ] @ args) in
  if Sys.command (command ^ " >/dev/null 2>&1") <> 0 then Alcotest.failf "git %s failed" (String.concat " " args)

let commit_count repo =
  let out = Filename.temp_file "work-write-git" ".out" in
  ignore (Sys.command (Filename.quote_command "git" ~stdout:out [ "-C"; repo.wl_home; "rev-list"; "--count"; "HEAD" ]));
  let n = int_of_string (String.trim (In_channel.with_open_bin out In_channel.input_all)) in
  Sys.remove out;
  n

(* A commit that does not happen is reported to the caller ([uncommitted]),
   never hidden: the answer is recorded either way (exit 0). *)
let test_commit_reported () =
  let plain = fixture () in
  Alcotest.(check bool) "not a git repository: uncommitted" true (flag "uncommitted" (ok plain (request (qid 0) "yes")));
  let repo = fixture () in
  git repo [ "init"; "-q" ];
  git repo [ "add"; "-A" ];
  git repo [ "commit"; "-q"; "-m"; "init" ];
  let doc = ok repo (request (qid 0) "committed") in
  Alcotest.(check bool) "committed: no uncommitted field" true (member "uncommitted" doc = `Null);
  Alcotest.(check int) "one commit more" 2 (commit_count repo);
  let lock = Filename.concat (Filename.concat repo.wl_home ".git") "index.lock" in
  Out_channel.with_open_bin lock ignore;
  let r = run repo (request (qid 1) "lock held") in
  Alcotest.(check int) "still recorded: exit 0" 0 r.code;
  Alcotest.(check bool) "a failed commit: uncommitted" true (flag "uncommitted" (json r));
  Alcotest.(check bool) "the reason goes to standard error" true (r.err <> "");
  Alcotest.(check int) "no commit made" 2 (commit_count repo);
  Alcotest.(check int) "both answers in the log" 2 (List.length (answer_events repo))

let contains ~sub s =
  let n = String.length sub in
  let rec at i = i + n <= String.length s && (String.sub s i n = sub || at (i + 1)) in
  at 0

(* Without git on PATH the reason names the missing git, not a missing repository. *)
let test_git_not_found () =
  let repo = fixture () in
  git repo [ "init"; "-q" ];
  let no_git = temp_dir "work-write-nogit" in
  let r = run ~env:[ ("PATH", no_git) ] repo (request (qid 0) "no git") in
  Alcotest.(check int) "still recorded: exit 0" 0 r.code;
  Alcotest.(check bool) "uncommitted" true (flag "uncommitted" (json r));
  Alcotest.(check bool) ("the reason says git was not found: " ^ r.err) true (contains ~sub:"git was not found" r.err);
  Alcotest.(check bool) "not that the repository is missing" false (contains ~sub:"not a git repository" r.err)

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
          Alcotest.test_case "the answer cap keeps the owner's answer" `Quick test_cap_keeps_owner_answer;
          Alcotest.test_case "the answer cap keeps the latest owner answer" `Quick test_cap_keeps_latest_owner_answer;
          Alcotest.test_case "owner_answered only for the owner's answer" `Quick test_open_question_flag;
          Alcotest.test_case "a commit that does not happen is reported" `Quick test_commit_reported;
          Alcotest.test_case "git not found is reported as such" `Quick test_git_not_found;
          Alcotest.test_case "concurrent writers" `Quick test_concurrent_writers;
          Alcotest.test_case "agent session refused" `Quick test_agent_session_refused;
          Alcotest.test_case "missing repository" `Quick test_missing_repository;
        ] );
      ("hostile input", Test_hostile.tests);
      ("answer options", Test_answer_options.tests);
    ]
