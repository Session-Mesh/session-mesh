(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Regression tests of the independent review: the folder never leaves the
   server (B1), nested output is bounded (S1), errors carry no path (S2),
   identity does not fall back or guess (S4). *)

open Work_client
open Work_support
module W = Mesh_worklog

let check_str msg expected actual = Alcotest.(check string) msg expected actual
let int_of = function `Int n -> n | _ -> -1

(* ---- B1 ---------------------------------------------------------------- *)

let test_repo_is_a_name () =
  let home, wl_home = fresh () in
  let dir = checkout () in
  let name = Filename.basename dir in
  let c = connect ~cwd:dir ~wl_home ~home () in
  let task = new_task c () in
  ignore (ok c "work_log" (`Assoc [ ("id", `String task); ("text", `String "x") ]));
  let found = ok c "work_find_sessions" (`Assoc [ ("task", `String task) ]) in
  assert_no_path ~what:"work_find_sessions" found;
  check_str "repo of a found session" name (str (List.hd (items found "sessions")) "repo");
  let got = ok c "work_get" (`Assoc [ ("id", `String task) ]) in
  assert_no_path ~what:"work_get" got;
  check_str "repo of a link" name (str (List.hd (items got "sessions")) "repo");
  Alcotest.(check bool) "the link event keeps the name" true
    (List.exists (fun e -> member "repo" e = `String name) (items got "timeline_newest_first"));
  let session = ok c "work_get_session" (`Assoc [ ("session", `String "probe-session") ]) in
  assert_no_path ~what:"work_get_session" session;
  check_str "repo in the session's links" name (str (List.hd (items session "links")) "repo");
  Alcotest.(check bool) "the folder is still kept in the data repository" true
    (contains (events_text wl_home) dir);
  stop c

(* ---- S1 ---------------------------------------------------------------- *)

let test_nested_lists_are_bounded () =
  with_server (fun c _ ->
      let task = new_task c () in
      for k = 0 to 5 do
        update_add c task "links" (List.init 20 (fun i -> long_link ((k * 20) + i)))
      done;
      let r = call c "work_get" (`Assoc [ ("id", `String task) ]) in
      Alcotest.(check bool) "a task with 120 links is readable" false r.is_error;
      let fields = member "task" r.json in
      Alcotest.(check bool) "links are capped" true (List.length (items fields "links") <= 20);
      Alcotest.(check bool) "the omitted links are counted" true (int_of (member "links_omitted" fields) >= 100);
      Alcotest.(check bool) "marked truncated" true (member "truncated" r.json = `Bool true);
      Alcotest.(check bool) "within the bound" true (String.length r.text <= Work_mcp.Work_tool.max_output_bytes);
      List.iter
        (fun l ->
          match l with
          | `String s -> Alcotest.(check bool) "a link is cut" true (String.length s <= 303)
          | _ -> Alcotest.fail "link is not a string")
        (items fields "links");
      let project =
        str (ok c "work_add_project" (`Assoc [ ("title", `String "P"); ("product", `String "gateway") ])) "id"
      in
      for k = 0 to 2 do
        update_add c project "milestones" (List.init 20 (fun i -> long_link ((k * 20) + i)))
      done;
      let p = call c "work_get" (`Assoc [ ("id", `String project) ]) in
      Alcotest.(check bool) "a project with 60 milestones is readable" false p.is_error;
      Alcotest.(check bool) "milestones omitted" true
        (int_of (member "milestones_omitted" (member "project" p.json)) >= 40);
      let listed = call c "work_list_projects" (`Assoc []) in
      Alcotest.(check bool) "the project list is readable" false listed.is_error)

let hundred_options = List.init 20 (fun i -> `String (string_of_int i ^ String.make 300 'o'))

let test_hand_written_question_is_bounded () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let ctx = library_ctx wl_home in
  let qid = "N-0badc0de" in
  let big = String.make 5000 'q' in
  W.Err.unwrap
    (W.Txn.run ctx (fun tx ->
         W.Txn.append tx
           [ ( qid, "question",
               [ ("id", `String qid); ("text", `String big); ("options", `List hundred_options);
                 ("assumption", `String big); ("session", `String "probe-session") ] ) ];
         for _ = 1 to 6 do
           W.Txn.append tx
             [ (qid, "answer", [ ("question", `String qid); ("text", `String big); ("by", `String big) ]) ]
         done));
  let listed = call c "work_list_questions" (`Assoc []) in
  Alcotest.(check bool) "readable" false listed.is_error;
  let q = List.hd (items listed.json "questions") in
  Alcotest.(check bool) "question text cut" true (String.length (str q "text") <= 2003);
  Alcotest.(check bool) "options cut" true (List.length (items q "options") <= 8);
  Alcotest.(check bool) "answers cut" true (List.length (items q "answers") <= 5);
  Alcotest.(check int) "answers omitted" 1 (int_of (member "answers_omitted" q));
  Alcotest.(check bool) "answer text cut" true
    (String.length (str (List.hd (items q "answers")) "text") <= 2003);
  Alcotest.(check bool) "work_resume still answers" false (call c "work_resume" (`Assoc [])).is_error;
  stop c

(* ---- S2 ---------------------------------------------------------------- *)

let check_clean_error ~what ~wl_home (r : reply) =
  Alcotest.(check bool) (what ^ ": refused") true r.is_error;
  assert_no_path_text ~what r.text;
  assert_no_path ~what r.json;
  Alcotest.(check bool) (what ^ ": no data directory") false (contains r.text wl_home);
  Alcotest.(check bool) (what ^ ": no temporary directory") false
    (contains r.text (Filename.get_temp_dir_name ()))

let test_errors_carry_no_path () =
  let home = temp_dir "work-mcp-errors" in
  let foreign = Filename.concat home "not-a-repo" in
  W.Appendfile.mkdir_p foreign;
  Out_channel.with_open_bin (Filename.concat foreign "keep.txt") (fun oc -> output_string oc "x");
  let c = connect ~wl_home:foreign ~home () in
  let r = call c "work_list_products" (`Assoc []) in
  check_str "code" "repository" (error_code r);
  check_clean_error ~what:"a directory that is not a repository" ~wl_home:foreign r;
  stop c;
  let blocker = Filename.concat home "a-file" in
  Out_channel.with_open_bin blocker (fun oc -> output_string oc "x");
  let under_file = Filename.concat blocker "data" in
  let c = connect ~wl_home:under_file ~home () in
  check_clean_error ~what:"a path below a file" ~wl_home:under_file (call c "work_resume" (`Assoc []));
  stop c;
  let c = connect ~wl_home:(Filename.concat home "missing") ~home () in
  Alcotest.(check bool) "a missing path below an existing directory is created, not refused" false
    (call c "work_list_products" (`Assoc [])).is_error;
  stop c

let test_first_use_reports_its_own_error () =
  if Unix.geteuid () = 0 then ()
  else begin
    let home = temp_dir "work-mcp-readonly" in
    let parent = Filename.concat home "ro" in
    W.Appendfile.mkdir_p parent;
    Unix.chmod parent 0o500;
    let wl_home = Filename.concat parent "data" in
    let c = connect ~wl_home ~home () in
    let r = call c "work_list_products" (`Assoc []) in
    Unix.chmod parent 0o700;
    check_clean_error ~what:"a repository that cannot be created" ~wl_home r;
    check_str "code" "repository" (error_code r);
    Alcotest.(check bool) "says the creation failed" true
      (contains r.text "could not be created at first use");
    stop c
  end

let test_write_warning_carries_no_path () =
  let home, wl_home = fresh () in
  let bin, _ = stand_in ~dir:home in
  let c = connect ~extra:[ path_with bin ] ~wl_home ~home () in
  let r = call c "work_add_task" (`Assoc [ ("title", `String "W"); ("product", `String "gateway") ]) in
  Alcotest.(check bool) "the write itself succeeds" false r.is_error;
  let warnings = items r.json "write_warnings" in
  Alcotest.(check bool) "the failed commit is reported" true (warnings <> []);
  assert_no_path ~what:"write_warnings" r.json;
  Alcotest.(check bool) "git's path is gone" false (contains r.text "/secret/place");
  stop c

(* ---- S4 ---------------------------------------------------------------- *)

let first_event ~extra ?unset ~session () =
  let home, wl_home = fresh () in
  let c = connect ~session ~extra ?unset ~wl_home ~home () in
  ignore (new_task c ());
  stop c;
  wl_home

let created wl_home =
  match List.find_opt (fun l -> contains l "\"type\":\"created\"") (event_lines wl_home) with
  | Some l -> Yojson.Safe.from_string l
  | None -> Alcotest.fail "no created event"

let test_invalid_session_does_not_fall_back () =
  let wl_home = first_event ~extra:[ "CLAUDE_CODE_SESSION_ID=uuid-1234-claude"; "WL_SESSION=other-name" ] ~session:"bad name" () in
  Alcotest.(check bool) "the session is unknown" true (member "session" (created wl_home) = `Null);
  Alcotest.(check bool) "no other variable is used" false (contains (events_text wl_home) "uuid-1234-claude");
  Alcotest.(check bool) "nothing is linked" false (contains (events_text wl_home) "session_linked");
  let wl_home = first_event ~extra:[ "CLAUDE_CODE_SESSION_ID=uuid-1234-claude" ] ~session:"" () in
  check_str "without MESH_SESSION the library's variables apply" "uuid-1234-claude" (str (created wl_home) "session")

let test_agent_markers () =
  let kind ~extra =
    str (created (first_event ~extra ~unset:[ "CLAUDECODE" ] ~session:"agent-y" ())) "agent"
  in
  check_str "a configuration directory is not a marker" "agent" (kind ~extra:[ "CODEX_HOME=/somewhere" ]);
  check_str "the thread of a Codex session is" "codex" (kind ~extra:[ "CODEX_THREAD_ID=thread-1" ]);
  check_str "an opencode session is" "opencode" (kind ~extra:[ "OPENCODE_SESSION_ID=oc-1" ]);
  check_str "a bare OPENCODE variable is not a marker" "agent" (kind ~extra:[ "OPENCODE=1" ]);
  check_str "WL_AGENT is the explicit override" "pi" (kind ~extra:[ "WL_AGENT=pi"; "CODEX_THREAD_ID=thread-1" ])

let test_token_not_inherited_by_git () =
  let home, wl_home = fresh () in
  let bin, log = stand_in ~dir:home in
  let c = connect ~extra:[ path_with bin ] ~wl_home ~home () in
  let task = new_task c () in
  ignore (ok c "work_log" (`Assoc [ ("id", `String task); ("text", `String "x") ]));
  stop c;
  let seen = read_file log in
  Alcotest.(check bool) "git ran" true (String.length seen > 0);
  Alcotest.(check bool) "the token is not in its environment" false (contains seen secret);
  Alcotest.(check bool) "the other variables still are" true (contains seen "HOME=")

let tests =
  [
    Alcotest.test_case "repo is a name, never a path" `Quick test_repo_is_a_name;
    Alcotest.test_case "nested lists are bounded" `Quick test_nested_lists_are_bounded;
    Alcotest.test_case "a hand-written question is bounded" `Quick test_hand_written_question_is_bounded;
    Alcotest.test_case "errors carry no path" `Quick test_errors_carry_no_path;
    Alcotest.test_case "first use reports its own error" `Quick test_first_use_reports_its_own_error;
    Alcotest.test_case "write warnings carry no path" `Quick test_write_warning_carries_no_path;
    Alcotest.test_case "invalid session does not fall back" `Quick test_invalid_session_does_not_fall_back;
    Alcotest.test_case "agent markers" `Quick test_agent_markers;
    Alcotest.test_case "git does not inherit the token" `Quick test_token_not_inherited_by_git;
  ]
