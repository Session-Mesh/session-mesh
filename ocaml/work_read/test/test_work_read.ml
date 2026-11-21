(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Work_read_runner
module U = Yojson.Safe.Util

let contains haystack needle =
  let n = String.length needle and m = String.length haystack in
  let rec at i = i + n <= m && (String.sub haystack i n = needle || at (i + 1)) in
  n = 0 || at 0

let ok repo args =
  let r = run repo args in
  if r.code <> 0 then Alcotest.failf "%s: exit %d: %s" (String.concat " " args) r.code r.out;
  json r

let ids key doc = List.map (fun t -> U.to_string (U.member "id" t)) (U.to_list (U.member key doc))
let str_list j = List.map U.to_string (U.to_list j)
let sorted = List.sort compare
let slist = Alcotest.(list string)

(* The fixture plus: a dependency, a session link with a folder and a
   repository path, a question with an answer and one about the project. *)
let enriched () =
  let repo = copy_fixture () in
  append_events repo
    [
      {|{"ts":"2026-11-09T10:00:00Z","task":"T-3c4d","type":"add","field":"blocked_by","value":"T-1a2b"}|};
      {|{"ts":"2026-11-09T10:01:00Z","task":"T-3c4d","type":"session_linked","agent":"codex","session":"s-new","cwd":"/srv/zed/secretrepo","host":"hostc","repo":"/srv/zed/secretrepo","branch":"feat/x"}|};
      {|{"ts":"2026-11-09T10:02:00Z","task":"T-3c4d","type":"question","id":"N-0000abcd","text":"Which slot?","options":["am","pm"],"assumption":"am","agent":"codex","session":"s-new"}|};
      {|{"ts":"2026-11-09T10:03:00Z","task":"T-3c4d","type":"answer","question":"N-0000abcd","text":"pm","by":"owner"}|};
      {|{"ts":"2026-11-09T10:04:00Z","task":"P-5e6f","type":"question","id":"N-0000beef","text":"Keep the pilot?","agent":"codex","session":"s-new"}|};
    ];
  repo

let test_products () =
  let doc = ok (copy_fixture ()) [ "products" ] in
  Alcotest.(check string) "command" "products" (U.to_string (U.member "command" doc));
  Alcotest.(check int) "schema" 1 (U.to_int (U.member "schema" doc));
  let platform = List.hd (U.to_list (U.member "categories" doc)) in
  let products = U.to_list (U.member "products" platform) in
  Alcotest.check slist "tree order" [ "gateway"; "relay"; "relay-core"; "relay-edge" ]
    (List.map (fun p -> U.to_string (U.member "id" p)) products);
  let relay = List.nth products 1 in
  Alcotest.(check int) "relay own" 0 (U.to_int (U.member "open" relay));
  Alcotest.(check int) "relay tree" 3 (U.to_int (U.member "open" (U.member "tree" relay)));
  Alcotest.(check int) "relay tree blocked" 1 (U.to_int (U.member "blocked_tasks" (U.member "tree" relay)));
  Alcotest.(check int) "active projects" 1 (U.to_int (U.member "projects" relay));
  let totals = U.member "totals" doc in
  Alcotest.(check int) "open" 7 (U.to_int (U.member "open" totals));
  Alcotest.(check int) "done" 1 (U.to_int (U.member "done" totals));
  Alcotest.(check bool) "not truncated" false (U.to_bool (U.member "truncated" doc))

let test_projects () =
  let repo = copy_fixture () in
  let doc = ok repo [ "projects" ] in
  Alcotest.check slist "projects" [ "P-5e6f" ] (ids "projects" doc);
  let p = List.hd (U.to_list (U.member "projects" doc)) in
  Alcotest.(check int) "open" 2 (U.to_int (U.member "open" p));
  Alcotest.(check int) "blockers" 1 (U.to_int (U.member "blockers" p));
  Alcotest.(check bool) "progress" true (U.member "progress" p = `Float 0.0);
  let pseudo = List.map (fun e -> U.to_string (U.member "product" e)) (U.to_list (U.member "no_project" doc)) in
  Alcotest.check slist "tasks without project" [ "gateway"; "relay-core"; "relay-edge"; "supplies" ] pseudo;
  let scoped = ok repo [ "projects"; "--product"; "relay-core" ] in
  Alcotest.(check int) "no project of that product" 0 (List.length (U.to_list (U.member "projects" scoped)));
  Alcotest.check slist "its pseudo entry" [ "relay-core" ]
    (List.map (fun e -> U.to_string (U.member "product" e)) (U.to_list (U.member "no_project" scoped)));
  let rolled = ok repo [ "projects"; "--product"; "relay" ] in
  Alcotest.check slist "descendants are included" [ "P-5e6f" ] (ids "projects" rolled);
  let r = run repo [ "projects"; "--product"; "nowhere" ] in
  Alcotest.(check int) "unknown product" 3 r.code

let test_closed_projects () =
  let repo = copy_fixture () in
  append_events repo
    [
      {|{"ts":"2026-11-09T10:00:00Z","task":"P-aaaa","type":"project_created","title":"Old one","product":"gateway","category":"platform"}|};
      {|{"ts":"2026-11-09T10:01:00Z","task":"P-aaaa","type":"set","field":"status","to":"done"}|};
    ];
  Alcotest.check slist "active only" [ "P-5e6f" ] (ids "projects" (ok repo [ "projects" ]));
  Alcotest.check slist "all" [ "P-5e6f"; "P-aaaa" ] (sorted (ids "projects" (ok repo [ "projects"; "--all" ])))

let test_closed_task_dependency () =
  let repo = enriched () in
  let row doc = List.find (fun t -> U.to_string (U.member "id" t) = "T-3c4d") (U.to_list (U.member "tasks" doc)) in
  let before = row (ok repo [ "project"; "P-5e6f" ]) in
  Alcotest.(check bool) "an open task waits on an open dependency" true (U.to_bool (U.member "dependency_open" before));
  append_events repo [ {|{"ts":"2026-11-09T11:00:00Z","task":"T-3c4d","type":"set","field":"status","to":"done"}|} ];
  let after = row (ok repo [ "project"; "P-5e6f" ]) in
  Alcotest.(check string) "the task is closed" "done" (U.to_string (U.member "status" after));
  Alcotest.check slist "the dependency is still there" [ "T-1a2b" ] (str_list (U.member "blocked_by" after));
  Alcotest.(check bool) "a closed task does not wait" false (U.to_bool (U.member "dependency_open" after))

let test_project () =
  let doc = ok (enriched ()) [ "project"; "P-5e6f" ] in
  let project = U.member "project" doc in
  Alcotest.(check string) "title" "Delivery rollout" (U.to_string (U.member "title" project));
  Alcotest.check slist "milestones" [ "pilot run" ] (str_list (U.member "milestones" project));
  Alcotest.check slist "tasks" [ "T-1a2b"; "T-3c4d" ] (sorted (ids "tasks" doc));
  let columns = U.member "columns" doc in
  Alcotest.check slist "a todo task with an open blocker is blocked" [ "T-3c4d" ] (str_list (U.member "blocked" columns));
  Alcotest.check slist "todo column" [] (str_list (U.member "todo" columns));
  Alcotest.check slist "in progress column" [ "T-1a2b" ] (str_list (U.member "in_progress" columns));
  let edge = List.hd (U.to_list (U.member "dependencies" doc)) in
  Alcotest.(check string) "edge from" "T-3c4d" (U.to_string (U.member "from" edge));
  Alcotest.(check string) "edge to" "T-1a2b" (U.to_string (U.member "to" edge));
  Alcotest.(check string) "edge state" "open" (U.to_string (U.member "state" edge));
  Alcotest.(check bool) "edge inside" true (U.to_bool (U.member "to_in_project" edge));
  Alcotest.(check int) "open questions" 1 (U.to_int (U.member "open_questions" doc));
  let about = List.map (fun q -> U.to_string (U.member "about" q)) (U.to_list (U.member "questions" doc)) in
  Alcotest.check slist "questions of the project and its tasks" [ "P-5e6f"; "T-3c4d" ] (sorted about);
  Alcotest.(check bool) "reprise blocked" true
    (List.mem "T-3c4d" (ids "blocked" (U.member "reprise" doc)));
  Alcotest.(check bool) "timeline" true (U.to_list (U.member "timeline" doc) <> []);
  Alcotest.(check int) "unknown" 3 (run (copy_fixture ()) [ "project"; "P-ffff" ]).code

let test_task () =
  let doc = ok (enriched ()) [ "task"; "T-3c4d" ] in
  Alcotest.(check string) "title" "Book the harbour slot" (U.to_string (U.member "title" (U.member "task" doc)));
  Alcotest.(check string) "project" "P-5e6f" (U.to_string (U.member "id" (U.member "project" doc)));
  Alcotest.check slist "open blocker" [ "B-0c0ffe" ] (ids "open_blockers" doc);
  let dep = List.hd (U.to_list (U.member "blocked_by" doc)) in
  Alcotest.(check string) "target state" "open" (U.to_string (U.member "state" dep));
  Alcotest.(check string) "target status" "in_progress" (U.to_string (U.member "status" dep));
  let sessions = U.to_list (U.member "sessions" doc) in
  Alcotest.check slist "sessions" [ "s-new"; "s-old" ]
    (sorted (List.map (fun s -> U.to_string (U.member "name" s)) sessions));
  let fresh = List.find (fun s -> U.to_string (U.member "name" s) = "s-new") sessions in
  Alcotest.(check string) "repo is a name" "secretrepo" (U.to_string (U.member "repo" fresh));
  Alcotest.(check string) "agent" "codex" (U.to_string (U.member "agent" fresh));
  let q = List.hd (U.to_list (U.member "questions" doc)) in
  Alcotest.(check string) "question" "Which slot?" (U.to_string (U.member "text" q));
  Alcotest.(check string) "answered" "answered" (U.to_string (U.member "state" q));
  Alcotest.(check int) "no open question" 0 (U.to_int (U.member "open_questions" doc));
  let blocking = U.to_list (U.member "blocking" (ok (enriched ()) [ "task"; "T-1a2b" ])) in
  Alcotest.check slist "blocking" [ "T-3c4d" ] (List.map (fun t -> U.to_string (U.member "id" t)) blocking)

let test_task_timeline () =
  let doc = ok (copy_fixture ()) [ "task"; "T-1a2b" ] in
  let events = U.to_list (U.member "timeline" doc) in
  let decision = List.find (fun e -> U.to_string (U.member "type" e) = "decision") events in
  Alcotest.(check string) "text" "ship by road, not by rail" (U.to_string (U.member "text" decision));
  Alcotest.(check string) "provenance" "inferred" (U.to_string (U.member "prov" decision));
  let first = U.to_string (U.member "at" (List.hd events)) and last = U.to_string (U.member "at" (List.nth events (List.length events - 1))) in
  Alcotest.(check bool) "newest first" true (first > last);
  Alcotest.(check bool) "notes of the task file" true (contains (U.to_string (U.member "notes" doc)) "Next step: confirm the van.")

let test_resume () =
  let repo = enriched () in
  let doc = ok repo [ "resume" ] in
  Alcotest.(check bool) "no here section" true (U.member "here" doc = `Null);
  Alcotest.check slist "in progress" [ "T-1a2b"; "T-6b7c" ] (sorted (ids "in_progress" doc));
  Alcotest.(check bool) "blocked holds the task with a blocker" true (List.mem "T-3c4d" (ids "blocked" doc));
  Alcotest.check slist "stale" [ "T-4f5a" ] (ids "stale" doc);
  Alcotest.check slist "due" [ "T-2d3e" ] (ids "due" doc);
  Alcotest.(check bool) "no todo section by default" true (U.member "todo" doc = `Null);
  Alcotest.(check bool) "todo with --all" true (U.member "todo" (ok repo [ "resume"; "--all" ]) <> `Null);
  Alcotest.(check int) "open questions" 1 (U.to_int (U.member "open_questions" doc));
  let scoped = ok repo [ "resume"; "--project"; "P-5e6f" ] in
  Alcotest.check slist "scoped to a project" [ "T-1a2b" ] (ids "in_progress" scoped)

let test_sessions_of () =
  let repo = enriched () in
  let names doc = sorted (List.map (fun s -> U.to_string (U.member "name" s)) (U.to_list (U.member "sessions" doc))) in
  Alcotest.check slist "product with descendants" [ "s-here"; "s-new"; "s-old" ]
    (names (ok repo [ "sessions-of"; "--product"; "relay" ]));
  Alcotest.check slist "project" [ "s-new"; "s-old" ] (names (ok repo [ "sessions-of"; "--project"; "P-5e6f" ]));
  Alcotest.check slist "task" [ "s-new"; "s-old" ] (names (ok repo [ "sessions-of"; "--task"; "T-3c4d" ]));
  let doc = ok repo [ "sessions-of"; "--product"; "gateway" ] in
  Alcotest.check slist "a product with no linked session" [] (names doc);
  let old_one =
    List.find (fun s -> U.to_string (U.member "name" s) = "s-old")
      (U.to_list (U.member "sessions" (ok repo [ "sessions-of"; "--task"; "T-3c4d" ])))
  in
  Alcotest.check slist "projects touched" [ "P-5e6f" ] (str_list (U.member "projects" old_one))

let bad_arguments =
  [
    [];
    [ "nothing" ];
    [ "products"; "extra" ];
    [ "projects"; "--product" ];
    [ "projects"; "--product"; "a"; "--product"; "b" ];
    [ "projects"; "--unknown" ];
    [ "projects"; "stray" ];
    [ "projects"; "--product"; "--all" ];
    [ "projects"; "--product"; "../x" ];
    [ "projects"; "--product"; "a\007b" ];
    [ "projects"; "--product"; "a\xe2\x80\xaeb" ];
    [ "project" ];
    [ "project"; "T-1a2b" ];
    [ "project"; "P-1a2b"; "P-1a2b" ];
    [ "task"; "T-1a2b/../x" ];
    [ "task"; "1a2b" ];
    [ "task"; "T-" ];
    [ "resume"; "--project"; "T-1a2b" ];
    [ "sessions-of" ];
    [ "sessions-of"; "--product"; "a"; "--task"; "T-1a2b" ];
    [ "sessions-of"; "--all" ];
    [ "projects"; "--product"; String.make 101 'a' ];
  ]

let test_strict_arguments () =
  let repo = copy_fixture () in
  List.iter
    (fun args ->
      let r = run repo args in
      let label = String.escaped (String.concat " " args) in
      Alcotest.(check int) ("exit code of: " ^ label) 2 r.code;
      let error = U.member "error" (json r) in
      Alcotest.(check string) ("code of: " ^ label) "invalid_input" (U.to_string (U.member "code" error)))
    bad_arguments

let test_missing_repository () =
  let repo = copy_fixture () in
  let missing = Filename.concat (temp_dir "work-read-none") "absent" in
  let r = run ~env:[ ("WL_HOME", missing) ] repo [ "products" ] in
  Alcotest.(check int) "exit code" 6 r.code;
  Alcotest.(check string) "code" "repository" (U.to_string (U.member "code" (U.member "error" (json r))));
  Alcotest.(check bool) "nothing created" false (Sys.file_exists missing);
  Alcotest.(check bool) "no path in the message" false (contains r.out missing || contains r.out "/tmp")

let test_read_only () =
  let repo = enriched () in
  let before = tree_state (Filename.dirname repo.wl_home) in
  List.iter
    (fun args -> ignore (run repo args))
    [
      [ "products" ]; [ "projects"; "--all" ]; [ "project"; "P-5e6f" ]; [ "task"; "T-3c4d" ]; [ "resume"; "--all" ];
      [ "sessions-of"; "--product"; "relay" ]; [ "session-questions" ]; [ "task"; "T-ffff" ]; [ "open-questions" ];
    ];
  Alcotest.(check bool) "repository and home untouched" true (before = tree_state (Filename.dirname repo.wl_home));
  Alcotest.(check bool) "no lock file" false (Sys.file_exists (Filename.concat repo.wl_home ".wl.lock"));
  Alcotest.(check bool) "no git directory" false (Sys.file_exists (Filename.concat repo.wl_home ".git"))

let every_command =
  [
    [ "products" ]; [ "projects"; "--all" ]; [ "project"; "P-5e6f" ]; [ "task"; "T-3c4d" ]; [ "task"; "T-1a2b" ];
    [ "resume"; "--all" ]; [ "sessions-of"; "--product"; "relay" ]; [ "sessions-of"; "--task"; "T-3c4d" ];
    [ "session-questions" ]; [ "open-questions" ];
  ]

let test_no_path_leak () =
  let repo = enriched () in
  let forbidden = [ repo.home; repo.wl_home; "/srv/zed"; "/work/relay"; "/work"; Filename.get_temp_dir_name () ] in
  List.iter
    (fun args ->
      let r = run repo args in
      List.iter
        (fun needle ->
          let label = Printf.sprintf "%s leaks %s" (String.concat " " args) needle in
          Alcotest.(check bool) label false (contains r.out needle || contains r.err needle))
        forbidden)
    every_command;
  let r = run ~env:[ ("WL_HOME", Filename.concat repo.wl_home "taxonomy.yaml") ] repo [ "products" ] in
  Alcotest.(check bool) "error without path" false (contains r.out repo.wl_home)

let test_cleaned_text () =
  let repo = copy_fixture () in
  let tasks = Filename.concat (Filename.concat repo.wl_home "tasks") "gateway" in
  let file = Filename.concat tasks "T-1a2b-ship-the-first-delivery.md" in
  let original = In_channel.with_open_bin file In_channel.input_all in
  write_file file (original ^ "\nhidden\xe2\x80\xaeevil \x07bell \x1b[31mred \xe2\x80\x8bzero \xff bad\n");
  let r = run repo [ "task"; "T-1a2b" ] in
  Alcotest.(check int) "exit" 0 r.code;
  let notes = U.to_string (U.member "notes" (json r)) in
  Alcotest.(check bool) "notes kept" true (contains notes "hidden");
  (* The JSON escapes control bytes, so they are looked for in the decoded value; bidi,
     zero-width and invalid bytes would appear as they are in the output. *)
  List.iter
    (fun (name, bad) -> Alcotest.(check bool) name false (contains notes bad))
    [ ("bell", "\x07"); ("escape", "\x1b"); ("bidi", "\xe2\x80\xae"); ("zero width", "\xe2\x80\x8b") ];
  List.iter
    (fun (name, bad) -> Alcotest.(check bool) name false (contains r.out bad))
    [ ("bidi", "\xe2\x80\xae"); ("zero width", "\xe2\x80\x8b"); ("raw invalid byte", "\xff") ]

let test_caps () =
  let repo = copy_fixture () in
  let created =
    List.init 260 (fun i ->
        Printf.sprintf
          {|{"ts":"2026-11-09T10:%02d:%02dZ","task":"T-%04x","type":"created","title":"Bulk %d","project":"gateway","category":"platform","priority":"P2","status":"todo"}|}
          (i / 60) (i mod 60) (0x9000 + i) i)
    @ List.init 260 (fun i ->
          Printf.sprintf {|{"ts":"2026-11-09T11:%02d:%02dZ","task":"T-%04x","type":"set","field":"project","to":"P-5e6f"}|}
            (i / 60) (i mod 60) (0x9000 + i))
  in
  append_events repo created;
  let r = run repo [ "project"; "P-5e6f" ] in
  Alcotest.(check int) "exit" 0 r.code;
  let doc = json r in
  Alcotest.(check int) "tasks capped" 200 (List.length (U.to_list (U.member "tasks" doc)));
  Alcotest.(check int) "omitted counted" 62 (U.to_int (U.member "tasks_omitted" doc));
  Alcotest.(check bool) "truncated flag" true (U.to_bool (U.member "truncated" doc));
  Alcotest.(check bool) "within the output bound" true (String.length r.out < 1_000_000);
  let long = String.make 20000 'n' in
  let file = Filename.concat (Filename.concat (Filename.concat repo.wl_home "tasks") "gateway") "T-1a2b-ship-the-first-delivery.md" in
  write_file file (In_channel.with_open_bin file In_channel.input_all ^ "\n" ^ long ^ "\n");
  let task = json (run repo [ "task"; "T-1a2b" ]) in
  Alcotest.(check bool) "long notes cut" true (String.length (U.to_string (U.member "notes" task)) <= 8003);
  Alcotest.(check bool) "long notes flag" true (U.to_bool (U.member "truncated" task))

let () =
  Alcotest.run "work-read"
    [
      ( "subcommands",
        [
          Alcotest.test_case "products" `Quick test_products;
          Alcotest.test_case "projects" `Quick test_projects;
          Alcotest.test_case "closed projects" `Quick test_closed_projects;
          Alcotest.test_case "project" `Quick test_project;
          Alcotest.test_case "closed task dependency" `Quick test_closed_task_dependency;
          Alcotest.test_case "task" `Quick test_task;
          Alcotest.test_case "task timeline" `Quick test_task_timeline;
          Alcotest.test_case "resume" `Quick test_resume;
          Alcotest.test_case "sessions-of" `Quick test_sessions_of;
        ] );
      ( "safety",
        [
          Alcotest.test_case "strict arguments" `Quick test_strict_arguments;
          Alcotest.test_case "missing repository" `Quick test_missing_repository;
          Alcotest.test_case "read only" `Quick test_read_only;
          Alcotest.test_case "no path leak" `Quick test_no_path_leak;
          Alcotest.test_case "cleaned text" `Quick test_cleaned_text;
          Alcotest.test_case "caps" `Quick test_caps;
        ] );
      ("limits", Test_limits.tests);
      ("session-questions", Test_session_questions.tests);
      ("context", Test_context.tests);
      ("context codex", Test_context_codex.tests);
      ("ids", Test_ids.tests);
      ("attempts", Test_read_attempts.tests);
      ("question context", Test_question_context.tests);
      ("open-questions", Test_open_questions.tests);
    ]
