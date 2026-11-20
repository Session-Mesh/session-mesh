(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* [session-questions]: the open questions of each session, by session name.
   The fixture links s-old to T-3c4d (in P-5e6f) and s-here to T-6b7c (in no
   project with a question); the events below add s-new to T-3c4d and five
   questions, one of them answered. *)

open Work_read_runner
module U = Yojson.Safe.Util

let slist = Alcotest.(list string)

let contains haystack needle =
  let n = String.length needle and m = String.length haystack in
  let rec at i =
    i + n <= m && (String.sub haystack i n = needle || at (i + 1))
  in
  n = 0 || at 0

let ok ?input repo args =
  let r = run ?input repo args in
  if r.code <> 0 then
    Alcotest.failf "%s: exit %d: %s" (String.concat " " args) r.code r.out;
  json r

let question ts about id session =
  Printf.sprintf
    {|{"ts":"%s","task":"%s","type":"question","id":"%s","text":"Which one?","agent":"codex","session":"%s"}|}
    ts about id session

let tracker () =
  let repo = copy_fixture () in
  append_events repo
    [
      {|{"ts":"2026-11-09T10:01:00Z","task":"T-3c4d","type":"session_linked","agent":"codex","session":"s-new","cwd":"/srv/zed/secretrepo","host":"hostc","repo":"/srv/zed/secretrepo","branch":"feat/x"}|};
      (* answered: counts for nobody *)
      question "2026-11-09T10:02:00Z" "T-3c4d" "N-0000abcd" "s-new";
      {|{"ts":"2026-11-09T10:03:00Z","task":"T-3c4d","type":"answer","question":"N-0000abcd","text":"pm","by":"owner"}|};
      (* about the project of T-3c4d, asked by s-new: s-new once, s-old through its task *)
      question "2026-11-09T10:04:00Z" "P-5e6f" "N-0000beef" "s-new";
      (* about T-3c4d, asked by s-x: s-x, and the two sessions linked to the task *)
      question "2026-11-09T10:05:00Z" "T-3c4d" "N-00000a01" "s-x";
      (* about nothing: only its asker *)
      question "2026-11-09T10:06:00Z" "N-00000a02" "N-00000a02" "s-lone";
      (* about T-1a2b, a sibling task in P-5e6f: not s-old's (no link to T-1a2b) *)
      question "2026-11-09T10:07:00Z" "T-1a2b" "N-00000a03" "s-y";
    ];
  repo

let names doc =
  List.map
    (fun s -> U.to_string (U.member "name" s))
    (U.to_list (U.member "sessions" doc))

let session doc name =
  match
    List.find_opt
      (fun s -> U.to_string (U.member "name" s) = name)
      (U.to_list (U.member "sessions" doc))
  with
  | Some s -> s
  | None -> Alcotest.failf "no session %s" name

let question_ids s =
  List.map
    (fun q -> U.to_string (U.member "id" q))
    (U.to_list (U.member "questions" s))

let test_counts () =
  let doc = ok (tracker ()) [ "session-questions" ] in
  Alcotest.(check string)
    "command" "session-questions"
    (U.to_string (U.member "command" doc));
  Alcotest.(check int)
    "open questions of the tracker" 4
    (U.to_int (U.member "open_questions" doc));
  Alcotest.check slist "newest question first, then by name"
    [ "s-y"; "s-lone"; "s-new"; "s-old"; "s-x" ]
    (names doc);
  Alcotest.(check int) "total" 5 (U.to_int (U.member "total" doc));
  let count name = U.to_int (U.member "open_questions" (session doc name)) in
  Alcotest.(check int) "asked and about its project, once" 2 (count "s-new");
  Alcotest.check slist "s-new, newest first"
    [ "N-00000a01"; "N-0000beef" ]
    (question_ids (session doc "s-new"));
  Alcotest.(check int)
    "linked through its task, not the sibling task" 2 (count "s-old");
  Alcotest.check slist "s-old"
    [ "N-00000a01"; "N-0000beef" ]
    (question_ids (session doc "s-old"));
  Alcotest.(check int) "asked only" 1 (count "s-x");
  Alcotest.(check int) "about nothing" 1 (count "s-lone");
  Alcotest.(check bool) "truncated" false (U.to_bool (U.member "truncated" doc))

let test_targets () =
  let doc = ok (tracker ()) [ "session-questions" ] in
  let find name id =
    List.find
      (fun q -> U.member "id" q = `String id)
      (U.to_list (U.member "questions" (session doc name)))
  in
  let field key q =
    match U.member key q with `String s -> s | `Null -> "-" | _ -> "?"
  in
  let task_question = find "s-old" "N-00000a01"
  and project_question = find "s-old" "N-0000beef" in
  Alcotest.(check (pair string string))
    "about a task: its project" ("T-3c4d", "P-5e6f")
    (field "about" task_question, field "project" task_question);
  Alcotest.(check (pair string string))
    "about a project" ("P-5e6f", "P-5e6f")
    (field "about" project_question, field "project" project_question);
  let free = find "s-lone" "N-00000a02" in
  Alcotest.(check (pair string string))
    "about nothing" ("-", "-")
    (field "about" free, field "project" free);
  Alcotest.(check bool)
    "no question text" true
    (U.member "text" task_question = `Null)

let test_request_form () =
  let repo = tracker () in
  let doc = ok ~input:{|{"op":"session-questions"}|} repo [ "--request" ] in
  Alcotest.(check int) "same document" 5 (U.to_int (U.member "total" doc));
  List.iter
    (fun (input, args) ->
      let r = run ?input repo args in
      Alcotest.(check int) ("refused: " ^ String.concat " " args) 2 r.code)
    [
      (None, [ "session-questions"; "extra" ]);
      (None, [ "session-questions"; "--all" ]);
      (Some {|{"op":"session-questions","args":{"all":true}}|}, [ "--request" ]);
      ( Some {|{"op":"session-questions","args":{"id":"T-3c4d"}}|},
        [ "--request" ] );
    ]

let test_no_question () =
  let doc = ok (copy_fixture ()) [ "session-questions" ] in
  Alcotest.check slist "no session" [] (names doc);
  Alcotest.(check int)
    "no open question" 0
    (U.to_int (U.member "open_questions" doc))

let test_caps () =
  let repo = copy_fixture () in
  append_events repo
    (List.init 25 (fun i ->
         question
           (Printf.sprintf "2026-11-09T12:%02d:00Z" i)
           "T-3c4d"
           (Printf.sprintf "N-0000f0%02x" i)
           "s-many"));
  let s = session (ok repo [ "session-questions" ]) "s-many" in
  Alcotest.(check int)
    "every question counted" 25
    (U.to_int (U.member "open_questions" s));
  Alcotest.(check int) "at most 20 listed" 20 (List.length (question_ids s));
  Alcotest.(check int)
    "the others counted" 5
    (U.to_int (U.member "questions_omitted" s))

let test_session_cap () =
  let repo = copy_fixture () in
  let extra = 20 in
  append_events repo
    (List.init (500 + extra) (fun i ->
         question
           (Printf.sprintf "2026-11-09T12:00:%02dZ" (i mod 60))
           (Printf.sprintf "N-%08x" (0x1000 + i))
           (Printf.sprintf "N-%08x" (0x1000 + i))
           (Printf.sprintf "s-cap-%04d" i)));
  let doc = ok repo [ "session-questions" ] in
  Alcotest.(check int)
    "at most max_sessions listed" 500
    (List.length (names doc));
  Alcotest.(check int)
    "the others counted" extra
    (U.to_int (U.member "sessions_omitted" doc));
  Alcotest.(check bool) "truncated" true (U.to_bool (U.member "truncated" doc));
  Alcotest.(check int)
    "every question of the tracker still counted"
    (500 + extra)
    (U.to_int (U.member "open_questions" doc))

let test_no_path () =
  let repo = tracker () in
  let r = run repo [ "session-questions" ] in
  List.iter
    (fun needle ->
      Alcotest.(check bool) ("no " ^ needle) false (contains r.out needle))
    [ repo.home; repo.wl_home; "/srv/zed"; "/work" ]

let tests =
  [
    Alcotest.test_case "counts by session" `Quick test_counts;
    Alcotest.test_case "what each question is about" `Quick test_targets;
    Alcotest.test_case "request form and strict arguments" `Quick
      test_request_form;
    Alcotest.test_case "no open question" `Quick test_no_question;
    Alcotest.test_case "caps" `Quick test_caps;
    Alcotest.test_case "session cap" `Quick test_session_cap;
    Alcotest.test_case "no path" `Quick test_no_path;
  ]
