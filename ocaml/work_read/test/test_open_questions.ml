(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* [open-questions]: every open question, oldest first, a page at a time and in
   full, for the entry screen of the Projects view. [resume] keeps only the 20
   newest, shortened: with more open questions the oldest ones were seen
   nowhere. *)

open Work_read_runner
module U = Yojson.Safe.Util

let qid n = Printf.sprintf "N-0000d%03x" n

let question ?(about = "") ?(text = "Which one?") n =
  let about = if about = "" then qid n else about in
  Printf.sprintf
    {|{"ts":"2026-11-09T%02d:%02d:00Z","task":"%s","type":"question","id":"%s","text":"%s","agent":"codex","session":"s-ask"}|}
    (10 + (n / 60)) (n mod 60) about (qid n) text

let answer n =
  Printf.sprintf
    {|{"ts":"2026-11-09T18:00:00Z","task":"%s","type":"answer","question":"%s","text":"yes","by":"owner"}|} (qid n) (qid n)

(* The fixture's own open questions come first (they are older); 25 questions
   about nothing follow, the second one answered, and a long one last. *)
let long_text = String.make 1500 'x'

let tracker () =
  let repo = copy_fixture () in
  let before = U.to_int (U.member "open_questions" (json (run repo [ "open-questions" ]))) in
  append_events repo
    (List.init 25 (fun i -> question (i + 1))
    @ [ answer 2; question ~about:"T-3c4d" ~text:long_text 26 ]);
  (repo, before)

let ok repo args =
  let r = run repo args in
  if r.code <> 0 then Alcotest.failf "%s: exit %d: %s" (String.concat " " args) r.code r.out;
  json r

let ids doc = List.map (fun q -> U.to_string (U.member "id" q)) (U.to_list (U.member "questions" doc))
let omitted doc = match U.member "questions_omitted" doc with `Int n -> n | _ -> 0
let last l = List.nth l (List.length l - 1)

(* Read every page; the pages follow each other, oldest first, without a gap
   or a repeat, and the count is every open question. *)
let test_pages () =
  let repo, before = tracker () in
  let first = ok repo [ "open-questions" ] in
  Alcotest.(check int) "count of every open question" (before + 25) (U.to_int (U.member "open_questions" first));
  Alcotest.(check int) "a page of 20" 20 (List.length (ids first));
  Alcotest.(check int) "the rest is counted" (before + 25 - 20) (omitted first);
  (* At most 10 pages: a cursor that is not followed fails instead of looping. *)
  let rec pages n acc doc =
    let acc = acc @ ids doc in
    if omitted doc = 0 || n = 10 then acc else pages (n + 1) acc (ok repo [ "open-questions"; "--after"; last (ids doc) ])
  in
  let all = pages 1 [] first in
  let mine = List.filter (fun id -> String.length id > 6 && String.sub id 0 7 = "N-0000d") all in
  let expected = List.filter (fun id -> id <> qid 2) (List.init 26 (fun i -> qid (i + 1))) in
  Alcotest.(check (list string)) "oldest first, every open one, once" expected mine;
  Alcotest.(check int) "no repeat" (before + 25) (List.length all)

let test_oldest_kept () =
  let repo, _ = tracker () in
  let resume = ok repo [ "resume" ] in
  Alcotest.(check bool) "resume drops the oldest (the reason for this read)" false (List.mem (qid 1) (ids resume));
  Alcotest.(check bool) "open-questions gives it on the first page" true (List.mem (qid 1) (ids (ok repo [ "open-questions" ])))

let test_full_text_and_context () =
  let repo, _ = tracker () in
  let page = ok repo [ "open-questions"; "--after"; qid 25 ] in
  let q = List.hd (U.to_list (U.member "questions" page)) in
  Alcotest.(check string) "the newest one" (qid 26) (U.to_string (U.member "id" q));
  Alcotest.(check int) "text in full" 1500 (String.length (U.to_string (U.member "text" q)));
  Alcotest.(check string) "with its context" "Book the harbour slot"
    (U.to_string (U.member "task_title" (U.member "context" q)))

let test_after_answered_and_limit () =
  let repo, _ = tracker () in
  let page = ok repo [ "open-questions"; "--after"; qid 2; "--limit"; "3" ] in
  Alcotest.(check (list string)) "after an answered one" [ qid 3; qid 4; qid 5 ] (ids page);
  Alcotest.(check int) "the rest" 21 (omitted page)

let test_request () =
  let repo, _ = tracker () in
  let r = run ~input:{|{"op":"open-questions","args":{"after":"N-0000d001","limit":2}}|} repo [ "--request" ] in
  Alcotest.(check int) "exit" 0 r.code;
  Alcotest.(check (list string)) "page" [ qid 3; qid 4 ] (ids (json r))

let test_bad_arguments () =
  let repo, _ = tracker () in
  let code args = (run repo ("open-questions" :: args)).code in
  List.iter
    (fun args -> Alcotest.(check int) (String.concat " " args) 2 (code args))
    [
      [ "--limit"; "0" ]; [ "--limit"; "101" ]; [ "--limit"; "-1" ]; [ "--limit"; "1x" ]; [ "--limit"; "0x10" ];
      [ "--after"; "T-3c4d" ]; [ "--after"; "N-../x" ]; [ "extra" ]; [ "--after" ];
    ];
  Alcotest.(check int) "unknown question" 3 (code [ "--after"; "N-0000ffff" ]);
  let r = run ~input:{|{"op":"open-questions","args":{"limit":"many"}}|} repo [ "--request" ] in
  Alcotest.(check int) "request with a bad limit" 2 r.code

let tests =
  [
    Alcotest.test_case "pages" `Quick test_pages;
    Alcotest.test_case "the oldest is kept" `Quick test_oldest_kept;
    Alcotest.test_case "full text and context" `Quick test_full_text_and_context;
    Alcotest.test_case "after an answered question, limit" `Quick test_after_answered_and_limit;
    Alcotest.test_case "request" `Quick test_request;
    Alcotest.test_case "bad arguments" `Quick test_bad_arguments;
  ]
