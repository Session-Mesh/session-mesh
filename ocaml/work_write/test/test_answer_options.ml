(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Ww_runner
module U = Yojson.Safe.Util
module Q = Work_mcp.Work_questions

let member key j = U.member key j
let str key j = U.to_string (member key j)
let flag key j = match member key j with `Bool b -> b | _ -> false
let code_of r = str "code" (member "error" (json r))

let strings key j =
  match member key j with `List l -> List.map U.to_string l | _ -> []

let ok ?env repo input =
  let r = run ?env repo input in
  if r.code <> 0 then Alcotest.failf "exit %d: %s" r.code r.out;
  json r

let question repo id = List.find (fun q -> str "id" q = id) (questions repo)
let answers repo id = U.to_list (member "answers" (question repo id))

(* A question with options and a kind, as work_ask writes it. *)
let kind_line i kind opts =
  Printf.sprintf
    {|{"ts":"2026-11-08T09:00:00Z","task":"T-3c4d","type":"question","id":"%s","text":"Pick?","agent":"claude","session":"asking"%s%s}|}
    (qid i)
    (if opts = [] then ""
     else
       Printf.sprintf {|,"options":%s|}
         (Yojson.Safe.to_string (`List (List.map (fun o -> `String o) opts))))
    (match kind with Some k -> Printf.sprintf {|,"kind":"%s"|} k | None -> "")

let answer_request ?edit ?choices question text =
  let args =
    [ ("question", `String question); ("text", `String text) ]
    @ (match edit with Some e -> [ ("edit", `Bool e) ] | None -> [])
    @
    match choices with
    | Some c -> [ ("choices", `List (List.map (fun s -> `String s) c)) ]
    | None -> []
  in
  Yojson.Safe.to_string
    (`Assoc [ ("op", `String "answer"); ("args", `Assoc args) ])

let fixture_with lines = fixture ~questions:0 ~lines ()

(* Editing: a new owner answer that supersedes the earlier one; both stay. *)
let test_edit_supersedes () =
  let repo = fixture () in
  ignore (ok repo (request (qid 0) "8443"));
  let r = run repo (request (qid 0) "9443") in
  Alcotest.(check string)
    "without edit, still already_answered" "already_answered" (code_of r);
  let doc = ok repo (answer_request ~edit:true (qid 0) "9443") in
  Alcotest.(check bool) "recorded" false (flag "duplicate" doc);
  Alcotest.(check bool) "owner_verified" true (flag "owner_verified" doc);
  (match answers repo (qid 0) with
  | [ first; second ] ->
      Alcotest.(check string) "the earlier text stays" "8443" (str "text" first);
      Alcotest.(check bool)
        "the earlier answer is verified" true
        (flag "owner_verified" first);
      Alcotest.(check bool) "and superseded" true (flag "superseded" first);
      Alcotest.(check string) "the new text" "9443" (str "text" second);
      Alcotest.(check bool)
        "the new answer is not superseded" false (flag "superseded" second)
  | l -> Alcotest.failf "two answers expected, got %d" (List.length l));
  Alcotest.(check bool)
    "an edit to the current text is a duplicate" true
    (flag "duplicate" (ok repo (answer_request ~edit:true (qid 0) "9443")));
  (* Back to the first text: it differs from the current answer, so it is written. *)
  Alcotest.(check bool)
    "an edit back to an earlier text is written" false
    (flag "duplicate" (ok repo (answer_request ~edit:true (qid 0) "8443")));
  Alcotest.(check int) "three events" 3 (List.length (answer_events repo));
  Alcotest.(check bool)
    "an edit of an open question records it" false
    (flag "duplicate" (ok repo (answer_request ~edit:true (qid 1) "first")))

(* An edit that keeps the text but changes the choices is a correction, not a
   duplicate; the same text and choices again is. *)
let test_edit_choices_only () =
  let repo = fixture_with [ kind_line 0 (Some "single") [ "a"; "b" ] ] in
  ignore (ok repo (answer_request ~choices:[ "a" ] (qid 0) "a"));
  Alcotest.(check bool)
    "the choice dropped, same text: written" false
    (flag "duplicate" (ok repo (answer_request ~edit:true (qid 0) "a")));
  (match answers repo (qid 0) with
  | [ first; second ] ->
      Alcotest.(check (list string)) "the first keeps its choice" [ "a" ] (strings "choices" first);
      Alcotest.(check bool) "and is superseded" true (flag "superseded" first);
      Alcotest.(check (list string)) "the correction has none" [] (strings "choices" second)
  | l -> Alcotest.failf "two answers expected, got %d" (List.length l));
  Alcotest.(check bool)
    "the same text and choices again: a duplicate" true
    (flag "duplicate" (ok repo (answer_request ~edit:true (qid 0) "a")));
  Alcotest.(check bool)
    "without edit the text alone decides: a duplicate" true
    (flag "duplicate" (ok repo (answer_request ~choices:[ "b" ] (qid 0) "a")))

let test_choices_recorded () =
  let repo =
    fixture_with
      [
        kind_line 0 (Some "multi") [ "REST"; "gRPC"; "GraphQL" ];
        kind_line 1 None [ "a"; "b" ];
      ]
  in
  Alcotest.(check string)
    "multi read back" "multi"
    (str "kind" (question repo (qid 0)));
  Alcotest.(check string)
    "options without a kind: single" "single"
    (str "kind" (question repo (qid 1)));
  ignore
    (ok repo
       (answer_request ~choices:[ "REST"; "GraphQL" ] (qid 0) "REST\nGraphQL"));
  (match answers repo (qid 0) with
  | [ a ] ->
      Alcotest.(check (list string))
        "choices kept" [ "REST"; "GraphQL" ] (strings "choices" a);
      Alcotest.(check string) "text" "REST\nGraphQL" (str "text" a)
  | _ -> Alcotest.fail "one answer");
  ignore (ok repo (answer_request ~choices:[ "b" ] (qid 1) "b"));
  Alcotest.(check (list string))
    "single choice kept" [ "b" ]
    (strings "choices" (List.hd (answers repo (qid 1))))

let test_choices_refused () =
  let lines =
    [
      kind_line 0 (Some "single") [ "a"; "b" ];
      kind_line 1 (Some "text") [];
      kind_line 2 (Some "yes_no") [];
      kind_line 3 (Some "multi") [ "a"; "b" ];
    ]
  in
  let refused what input =
    let repo = fixture_with lines in
    let r = run repo input in
    Alcotest.(check int) (what ^ ": exit 2") 2 r.code;
    Alcotest.(check string)
      (what ^ ": invalid_input") "invalid_input" (code_of r);
    Alcotest.(check int)
      (what ^ ": nothing written")
      0
      (List.length (answer_events repo))
  in
  refused "a choice that is not an option"
    (answer_request ~choices:[ "c" ] (qid 0) "c");
  refused "two choices on a single question"
    (answer_request ~choices:[ "a"; "b" ] (qid 0) "a");
  refused "choices on a text question"
    (answer_request ~choices:[ "a" ] (qid 1) "a");
  refused "a yes_no choice other than yes or no"
    (answer_request ~choices:[ "maybe" ] (qid 2) "maybe");
  refused "a repeated choice" (answer_request ~choices:[ "a"; "a" ] (qid 3) "a");
  refused "nine choices"
    (answer_request ~choices:(List.init 9 (fun _ -> "a")) (qid 3) "a");
  refused "a choice that is not a string"
    (Printf.sprintf
       {|{"op":"answer","args":{"question":"%s","text":"a","choices":[1]}}|}
       (qid 3));
  refused "edit that is not a boolean"
    (Printf.sprintf
       {|{"op":"answer","args":{"question":"%s","text":"a","edit":"yes"}}|}
       (qid 3));
  refused "a repeated edit"
    (Printf.sprintf
       {|{"op":"answer","args":{"question":"%s","text":"a","edit":true,"edit":true}}|}
       (qid 3));
  let repo = fixture_with lines in
  ignore (ok repo (answer_request ~choices:[ "yes" ] (qid 2) "Oui"));
  Alcotest.(check (list string))
    "yes_no takes yes" [ "yes" ]
    (strings "choices" (List.hd (answers repo (qid 2))))

let tests =
  [
    Alcotest.test_case "an edit supersedes the owner's earlier answer" `Quick
      test_edit_supersedes;
    Alcotest.test_case "an edit of the choices alone is written" `Quick
      test_edit_choices_only;
    Alcotest.test_case "choices are recorded with the answer" `Quick
      test_choices_recorded;
    Alcotest.test_case "choices are checked against the question" `Quick
      test_choices_refused;
  ]
