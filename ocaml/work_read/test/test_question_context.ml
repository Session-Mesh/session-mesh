(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The [context] of the questions of [resume]: where each open question stands
   (task title, project, product, category), for the Projects view's list. The
   fixture has T-3c4d in P-5e6f (moved to product relay-edge, category platform) and
   T-6b7c in no project (relay-edge); T-9c0d is in the legacy category office. *)

open Work_read_runner
module U = Yojson.Safe.Util

let question ts about id =
  Printf.sprintf
    {|{"ts":"%s","task":"%s","type":"question","id":"%s","text":"Which one?","agent":"codex","session":"s-ask"}|}
    ts about id

let tracker () =
  let repo = copy_fixture () in
  append_events repo
    [
      question "2026-11-09T10:01:00Z" "T-3c4d" "N-0000c001";
      question "2026-11-09T10:02:00Z" "T-6b7c" "N-0000c002";
      question "2026-11-09T10:03:00Z" "P-5e6f" "N-0000c003";
      question "2026-11-09T10:04:00Z" "N-0000c004" "N-0000c004";
      question "2026-11-09T10:05:00Z" "T-9c0d" "N-0000c005";
      question "2026-11-09T10:06:00Z" "T-ffff" "N-0000c006";
    ];
  repo

let resume ?(args = []) repo =
  let r = run repo ("resume" :: args) in
  if r.code <> 0 then Alcotest.failf "resume: exit %d: %s" r.code r.out;
  json r

let context doc id =
  match List.find_opt (fun q -> U.to_string (U.member "id" q) = id) (U.to_list (U.member "questions" doc)) with
  | None -> Alcotest.failf "no question %s" id
  | Some q -> (
      match U.member "context" q with
      | `Null -> []
      | `Assoc fields -> List.map (fun (k, v) -> (k, U.to_string v)) fields
      | _ -> Alcotest.failf "context of %s is not an object" id)

let pairs = Alcotest.(list (pair string string))

let test_task_in_project () =
  Alcotest.check pairs "task in a project"
    [
      ("task_title", "Book the harbour slot");
      ("project", "P-5e6f");
      ("project_title", "Delivery rollout");
      ("product", "relay-edge");
      ("category", "platform");
    ]
    (context (resume (tracker ())) "N-0000c001")

let test_task_without_project () =
  Alcotest.check pairs "task in no project"
    [ ("task_title", "Draft the route plan"); ("product", "relay-edge"); ("category", "platform") ]
    (context (resume (tracker ())) "N-0000c002")

let test_project () =
  Alcotest.check pairs "about a project"
    [ ("project", "P-5e6f"); ("project_title", "Delivery rollout"); ("product", "relay"); ("category", "platform") ]
    (context (resume (tracker ())) "N-0000c003")

let test_legacy_category () =
  Alcotest.check pairs "legacy category"
    [ ("task_title", "Archive old labels"); ("product", "supplies"); ("category", "office") ]
    (context (resume (tracker ())) "N-0000c005")

let test_no_context () =
  let doc = resume (tracker ()) in
  Alcotest.check pairs "about nothing" [] (context doc "N-0000c004");
  Alcotest.check pairs "unknown task" [] (context doc "N-0000c006")

let test_scoped () =
  let doc = resume ~args:[ "--project"; "P-5e6f" ] (tracker ()) in
  Alcotest.(check int) "scoped count" 2 (U.to_int (U.member "open_questions" doc));
  Alcotest.(check string) "scoped context" "Book the harbour slot" (List.assoc "task_title" (context doc "N-0000c001"))

let test_only_resume () =
  let repo = tracker () in
  let task = json (run repo [ "task"; "T-3c4d" ]) in
  List.iter
    (fun q -> Alcotest.(check bool) "no context in task" true (U.member "context" q = `Null))
    (U.to_list (U.member "questions" task))

let tests =
  [
    Alcotest.test_case "task in a project" `Quick test_task_in_project;
    Alcotest.test_case "task in no project" `Quick test_task_without_project;
    Alcotest.test_case "about a project" `Quick test_project;
    Alcotest.test_case "legacy category" `Quick test_legacy_category;
    Alcotest.test_case "no context" `Quick test_no_context;
    Alcotest.test_case "scoped resume" `Quick test_scoped;
    Alcotest.test_case "only in resume" `Quick test_only_resume;
  ]
