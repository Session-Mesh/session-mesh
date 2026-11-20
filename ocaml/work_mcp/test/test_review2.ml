(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Regression tests of the second independent review (N1 to N14): control
   characters, a true output bound, UTF-8 safe cuts, the newest answers, the
   path sanitiser, identity warnings, first-use stalls and small mismatches. *)

open Work_client
open Work_support
module W = Mesh_worklog
module Q = Work_mcp.Work_questions

let check_str msg expected actual = Alcotest.(check string) msg expected actual
let int_of = function `Int n -> n | _ -> -1
let controls n = String.make n '\001'
let base_time () = int_of_float (Unix.time ()) - 3600

let rec has_bad_control = function
  | `String s -> Work_mcp.Work_err.has_control s
  | `List l -> List.exists has_bad_control l
  | `Assoc l -> List.exists (fun (k, v) -> Work_mcp.Work_err.has_control k || has_bad_control v) l
  | _ -> false

let last_raw_line () =
  match List.rev (List.filter (fun l -> l <> "") (String.split_on_char '\n' (Buffer.contents transcript))) with
  | l :: _ -> l
  | [] -> ""

let seed_question wl_home ~id ~ts ?(session = "probe-session") ?(extra = []) text =
  W.Err.unwrap
    (W.Txn.run (library_ctx ~now:(fun () -> ts) wl_home) (fun tx ->
         W.Txn.append tx
           [ (id, "question", [ ("id", `String id); ("text", `String text); ("session", `String session) ] @ extra) ]))

let seed_answer wl_home ~id ~ts text =
  ignore (W.Err.unwrap (Q.answer (library_ctx ~now:(fun () -> ts) wl_home) ~question:id ~text ~by:"owner" ()))

(* ---- N1: control characters ------------------------------------------- *)

let test_controls_refused () =
  with_server (fun c wl_home ->
      let task = new_task c () in
      let refused name args =
        let r = call c name args in
        Alcotest.(check bool) (name ^ " refused") true r.is_error;
        check_str (name ^ " code") "invalid_input" (error_code r)
      in
      let add extra = `Assoc ([ ("title", `String "T"); ("product", `String "gateway") ] @ extra) in
      refused "work_add_task" (add [ ("notes", `String ("x" ^ controls 7990)) ]);
      refused "work_add_task" (add [ ("owner", `String "o\027[2J") ]);
      refused "work_add_task" (add [ ("track", `String "t\000") ]);
      refused "work_add_task" (add [ ("tags", `List [ `String "ok"; `String "a\127b" ]) ]);
      refused "work_add_task" (add [ ("links", `List [ `String "https://e.invalid/\001" ]) ]);
      refused "work_add_task" (add [ ("notes", `String "carriage\r\nreturn") ]);
      refused "work_add_task" (add [ ("notes", `String "c1 \xC2\x85 control") ]);
      refused "work_log" (`Assoc [ ("id", `String task); ("text", `String "a\027]0;x\007") ]);
      refused "work_ask" (`Assoc [ ("text", `String "q\001") ]);
      refused "work_ask" (`Assoc [ ("text", `String "q"); ("options", `List [ `String "a\001" ]) ]);
      refused "work_ask" (`Assoc [ ("text", `String "q"); ("assumption", `String "\001") ]);
      refused "work_block" (`Assoc [ ("id", `String task); ("text", `String "b\001") ]);
      refused "work_block" (`Assoc [ ("id", `String task); ("text", `String "b"); ("on", `String "\001") ]);
      refused "work_update" (`Assoc [ ("id", `String task); ("set", `Assoc [ ("owner", `String "o\001") ]) ]);
      refused "work_update" (`Assoc [ ("id", `String task); ("add", `Assoc [ ("tags", `List [ `String "\001" ]) ]) ]);
      refused "work_add_project" (`Assoc [ ("title", `String "P"); ("product", `String "gateway"); ("goal", `String "g\001") ]);
      Alcotest.(check int) "nothing was written by a refused call" 1 (count_events wl_home "created");
      Alcotest.(check bool) "newline and tab are text" false
        (call c "work_log" (`Assoc [ ("id", `String task); ("text", `String "line one\nline\ttwo") ])).is_error)

let test_hand_written_task_is_readable () =
  with_server (fun c wl_home ->
      let id =
        W.Err.unwrap
          (W.Write_task.add (library_ctx wl_home) ~title:"H" ~product:"gateway" ~tags:[] ~links:[] ~also:[]
             ~notes:("x" ^ controls 7990) ())
      in
      let r = call c "work_get" (`Assoc [ ("id", `String id) ]) in
      Alcotest.(check bool) "a task with 7990 control characters is readable" false r.is_error;
      check_str "the controls are removed" "x" (str r.json "notes");
      Alcotest.(check bool) "within the bound" true (String.length r.text <= Work_mcp.Work_tool.max_output_bytes))

let test_fit_is_a_true_bound () =
  let accents = String.concat "" (List.init 40_000 (fun _ -> "\xC3\xA9")) in
  let json =
    `Assoc
      [
        ("task", `Assoc [ ("links", `List (List.init 100 (fun _ -> `String (String.make 1000 'q')))); ("title", `String "t") ]);
        ("notes", `String (String.make 60_000 '"'));
        ("deep", `Assoc [ ("a", `Assoc [ ("b", `String accents) ]) ]);
        ("small", `Int 1);
      ]
  in
  match Work_mcp.Work_tool.fit json with
  | None -> Alcotest.fail "a stored value must always fit"
  | Some fitted ->
      let text = Yojson.Safe.to_string fitted in
      Alcotest.(check bool) "within the bound" true (String.length text <= Work_mcp.Work_tool.max_output_bytes);
      Alcotest.(check bool) "marked truncated" true (member "truncated" fitted = `Bool true);
      Alcotest.(check bool) "still valid UTF-8" true (W.Textcheck.code_points text <> None);
      Alcotest.(check bool) "what fits is kept" true (member "small" fitted = `Int 1);
      Alcotest.(check bool) "links say how many were cut" true
        (int_of (member "links_omitted" (member "task" fitted)) > 0)

(* ---- N2: character-boundary cuts -------------------------------------- *)

let test_warning_cut_is_valid_utf8 () =
  let home, wl_home = fresh () in
  let message = "fatal: " ^ String.concat "" (List.init 400 (fun _ -> "\xC3\xA9")) in
  let bin, _ = stand_in_with ~message ~dir:home in
  let c = connect ~extra:[ path_with bin ] ~wl_home ~home () in
  let r = call c "work_add_task" (`Assoc [ ("title", `String "W"); ("product", `String "gateway") ]) in
  Alcotest.(check bool) "the failed commit is reported" true (items r.json "write_warnings" <> []);
  Alcotest.(check bool) "the whole response line is valid UTF-8" true
    (W.Textcheck.code_points (last_raw_line ()) <> None);
  stop c

(* ---- N3 and N4: answers and the briefing ------------------------------ *)

let test_newest_answers_are_kept () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let base = base_time () in
  seed_question wl_home ~id:"N-0000a001" ~ts:base "Many answers";
  for k = 1 to 7 do
    seed_answer wl_home ~id:"N-0000a001" ~ts:(base + k) (Printf.sprintf "answer %d" k)
  done;
  let q = List.hd (items (ok c "work_list_questions" (`Assoc [])) "questions") in
  let texts = List.map (fun a -> str a "text") (items q "answers") in
  Alcotest.(check (list string)) "the newest five, oldest of them first"
    [ "answer 3"; "answer 4"; "answer 5"; "answer 6"; "answer 7" ] texts;
  Alcotest.(check int) "two older ones are counted" 2 (int_of (member "answers_omitted" q));
  let session = ok c "work_get_session" (`Assoc [ ("session", `String "probe-session") ]) in
  let q = List.hd (items session "questions") in
  check_str "work_get_session keeps the newest too" "answer 7" (str (List.nth (items q "answers") 4) "text");
  stop c

let states mine = List.map (fun q -> str q "state") mine
let count_of state mine = List.length (List.filter (( = ) state) (states mine))

let test_resume_shows_answers_among_many_open () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let base = base_time () in
  for k = 0 to 11 do
    seed_question wl_home ~id:(Printf.sprintf "N-0000b%03x" k) ~ts:(base + k) (Printf.sprintf "open %d" k)
  done;
  seed_question wl_home ~id:"N-0000c001" ~ts:(base + 20) "answered one";
  seed_answer wl_home ~id:"N-0000c001" ~ts:(base + 21) "the owner's answer";
  let resume = ok c "work_resume" (`Assoc []) in
  let mine = items resume "my_questions" in
  Alcotest.(check int) "ten at most" 10 (List.length mine);
  Alcotest.(check bool) "the answered question is shown" true (List.mem "answered" (states mine));
  Alcotest.(check int) "open ones left out" 3 (int_of (member "my_open_questions_omitted" resume));
  for k = 0 to 4 do
    let id = Printf.sprintf "N-0000d%03x" k in
    seed_question wl_home ~id ~ts:(base + 30 + k) "more answered";
    seed_answer wl_home ~id ~ts:(base + 40 + k) "ok"
  done;
  let resume = ok c "work_resume" (`Assoc []) in
  let mine = items resume "my_questions" in
  Alcotest.(check int) "still ten" 10 (List.length mine);
  Alcotest.(check int) "six open" 6 (count_of "open" mine);
  Alcotest.(check int) "four answered" 4 (count_of "answered" mine);
  Alcotest.(check int) "open omitted" 6 (int_of (member "my_open_questions_omitted" resume));
  Alcotest.(check int) "answered omitted" 2 (int_of (member "my_answered_questions_omitted" resume));
  Alcotest.(check int) "total omitted" 8 (int_of (member "my_questions_omitted" resume));
  stop c

(* ---- N5: the path sanitiser ------------------------------------------- *)

let test_sanitiser () =
  let sanitise = Work_mcp.Work_err.sanitise in
  let case what input expected = check_str what expected (sanitise input) in
  case "after typographic quotes" "cannot lock \xE2\x80\x98/srv/secret/a\xE2\x80\x99 now" "cannot lock \xE2\x80\x98<path>\xE2\x80\x99 now";
  case "after guillemets and no-break spaces" "\xC2\xAB\xC2\xA0/srv/secret/dir\xC2\xA0\xC2\xBB" "\xC2\xAB\xC2\xA0<path>\xC2\xA0\xC2\xBB";
  case "after ASCII quotes" "fatal: '/srv/secret/a' and \"/srv/secret/b\"" "fatal: '<path>' and \"<path>\"";
  case "a flag glued to a path" "git -C/srv/s/e status" "git -C<path> status";
  case "a relative path of several components" "see x/srv/secret/b." "see <path>.";
  case "a home path" "open ~/notes/x: denied" "open <path>: denied";
  case "key and value" "dir=/srv/s/e;" "dir=<path>;";
  case "a path then a colon" "open /srv/s/e: Permission denied" "open <path>: Permission denied";
  case "a URL stays readable" "see https://example.invalid/a/b?c=d for more" "see https://example.invalid/a/b?c=d for more";
  case "a file URL does not" "at file:///srv/secret/a." "at file://<path>.";
  case "a plain word with one slash" "stdin/stdout and/or" "stdin/stdout and/or";
  let home = Sys.getenv_opt "HOME" in
  Unix.putenv "HOME" "/usr/al";
  let result = sanitise "wrote /usr/alice/p and /usr/al/q" in
  Option.iter (Unix.putenv "HOME") home;
  check_str "no home replacement without a boundary" "wrote <path> and <path>" result

let test_warning_forms_leave_no_path () =
  let home, wl_home = fresh () in
  let message = "fatal: \xE2\x80\x98/srv/secret/a\xE2\x80\x99 \xC2\xAB /srv/secret/dir \xC2\xBB -C/srv/secret/e x/srv/secret/b" in
  let bin, _ = stand_in_with ~message ~dir:home in
  let c = connect ~extra:[ path_with bin ] ~wl_home ~home () in
  let r = call c "work_add_task" (`Assoc [ ("title", `String "W"); ("product", `String "gateway") ]) in
  Alcotest.(check bool) "reported" true (items r.json "write_warnings" <> []);
  Alcotest.(check bool) "no path in the output" false (contains (last_raw_line ()) "/srv/secret");
  stop c

(* ---- N6 and N13: untrusted text, error text --------------------------- *)

let test_terminal_escapes_are_removed () =
  with_server (fun c wl_home ->
      let task = new_task c () in
      let ctx = library_ctx wl_home in
      let escape = "a\027[2J\027]0;pwned\007b" in
      W.Err.unwrap (W.Write_task.log ctx ~task ~kind:"progress" escape |> Result.map ignore);
      seed_question wl_home ~id:"N-0000e001" ~ts:(base_time ()) ~extra:[ ("assumption", `String escape) ] escape;
      W.Err.unwrap
        (W.Txn.run ctx (fun tx ->
             W.Txn.append tx
               [ ("N-0000e001", "answer", [ ("question", `String "N-0000e001"); ("text", `String escape); ("by", `String "owner") ]) ]));
      List.iter
        (fun (name, args) ->
          let r = call c name args in
          Alcotest.(check bool) (name ^ " readable") false r.is_error;
          Alcotest.(check bool) (name ^ ": no control character in the data") false (has_bad_control r.json);
          Alcotest.(check bool) (name ^ ": no escape on the wire") false
            (contains (last_raw_line ()) "\\u001b" || contains (last_raw_line ()) "\\u0007"))
        [ ("work_get", `Assoc [ ("id", `String task) ]);
          ("work_list_tasks", `Assoc []);
          ("work_list_questions", `Assoc []);
          ("work_get_session", `Assoc [ ("session", `String "probe-session") ]) ])

let test_error_text_is_sanitised () =
  with_server (fun c _ ->
      let r = call c "work_get_session" (`Assoc [ ("session", `String "nobody /srv/secret/a") ]) in
      Alcotest.(check bool) "refused" true r.is_error;
      Alcotest.(check bool) "no path in the text content" false (contains r.text "/srv/secret");
      Alcotest.(check bool) "no path in the structured content" false (contains (Yojson.Safe.to_string r.json) "/srv/secret"));
  Alcotest.(check bool) "the instructions list work_ask among the linking writes" true
    (contains Work_mcp.Work_instructions.text "work_ask with a task");
  Alcotest.(check bool) "the instructions ask to attach each question to its task or project" true
    (contains Work_mcp.Work_instructions.text "Attach each question to the task or project it concerns")

(* ---- N7, N8, minor: identity, stalls, first use ----------------------- *)

let test_identity_warning () =
  let warns ~session ~extra =
    let home, wl_home = fresh () in
    let c = connect ~session ~extra ~wl_home ~home () in
    let r = call c "work_add_task" (`Assoc [ ("title", `String "I"); ("product", `String "gateway") ]) in
    stop c;
    Alcotest.(check bool) "the write itself succeeds" false r.is_error;
    List.exists (function `String s -> contains s "identity" | _ -> false) (try items r.json "write_warnings" with _ -> [])
  in
  Alcotest.(check bool) "a valid session with an invalid WL_AGENT" true (warns ~session:"s10" ~extra:[ "WL_AGENT=Bad_Agent" ]);
  Alcotest.(check bool) "an invalid MESH_SESSION" true (warns ~session:"bad name" ~extra:[]);
  Alcotest.(check bool) "a good identity is not reported" false (warns ~session:"s11" ~extra:[])

let test_foreign_directory_fails_at_once () =
  let home = temp_dir "work-mcp-foreign" in
  let dir = checkout () in
  W.Appendfile.mkdir_p (Filename.concat dir "events");
  W.Appendfile.mkdir_p (Filename.concat dir "tasks");
  let c = connect ~wl_home:dir ~home () in
  let started = Unix.gettimeofday () in
  let r = call c "work_list_products" (`Assoc []) in
  let elapsed = Unix.gettimeofday () -. started in
  check_str "refused" "repository" (error_code r);
  Alcotest.(check bool) (Printf.sprintf "fails at once, not after a retry loop (%.2f s)" elapsed) true (elapsed < 1.0);
  stop c

let test_misspelt_home_does_not_create_a_chain () =
  let home = temp_dir "work-mcp-chain" in
  let c = connect ~wl_home:(Filename.concat home "missing/a/b") ~home () in
  let r = call c "work_list_products" (`Assoc []) in
  check_str "refused" "repository" (error_code r);
  Alcotest.(check bool) "no parent was created" false (Sys.file_exists (Filename.concat home "missing"));
  stop c;
  let c = connect ~wl_home:(Filename.concat home "one-level") ~home () in
  Alcotest.(check bool) "one level is created" false (call c "work_list_products" (`Assoc [])).is_error;
  stop c

(* ---- N10, N11, N12, N14 ----------------------------------------------- *)

let test_session_links_are_its_own () =
  let home, wl_home = fresh () in
  let c1 = connect ~session:"s1" ~wl_home ~home () in
  let c2 = connect ~session:"s2" ~wl_home ~home () in
  let task = new_task c1 () in
  ignore (ok c2 "work_log" (`Assoc [ ("id", `String task); ("text", `String "from s2") ]));
  let session = ok c1 "work_get_session" (`Assoc [ ("session", `String "s1") ]) in
  Alcotest.(check (list string)) "only s1" [ "s1" ] (List.map (fun l -> str l "name") (items session "links"));
  stop c1;
  stop c2

let test_malformed_question_id_is_reported () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  seed_question wl_home ~id:"N-ABCDEF12" ~ts:(base_time ()) "Uppercase id";
  let listed = ok c "work_list_questions" (`Assoc []) in
  Alcotest.(check bool) "a data warning names the id" true
    (contains (Yojson.Safe.to_string (member "data_warnings" listed)) "N-ABCDEF12");
  stop c

let test_question_limits_count_characters () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let cjk n = String.concat "" (List.init n (fun _ -> "\xE6\xBC\xA2")) in
  seed_question wl_home ~id:"N-0000f001" ~ts:(base_time ()) ~extra:[ ("assumption", `String (cjk 900)); ("options", `List [ `String (cjk 90) ]) ] (cjk 1500);
  seed_answer wl_home ~id:"N-0000f001" ~ts:(base_time () + 1) (cjk 1900);
  let q = List.hd (items (ok c "work_list_questions" (`Assoc [])) "questions") in
  Alcotest.(check int) "question text keeps its 1500 characters" 1500 (W.Textcheck.length (str q "text"));
  Alcotest.(check int) "assumption keeps its 900" 900 (W.Textcheck.length (str q "assumption"));
  Alcotest.(check int) "option keeps its 90" 90 (W.Textcheck.length (List.hd (List.map (function `String s -> s | _ -> "") (items q "options"))));
  Alcotest.(check int) "answer keeps its 1900" 1900 (W.Textcheck.length (str (List.hd (items q "answers")) "text"));
  Alcotest.(check int) "longer than the limit is cut by characters" 2003
    (W.Textcheck.length (Work_mcp.Work_render.trunc_chars ~max:2000 (cjk 2500)));
  stop c

let test_repo_hides_the_home_directory () =
  let home, wl_home = fresh () in
  run_ok (Printf.sprintf "git init -q %s" (Filename.quote home));
  let c = connect ~cwd:(Unix.realpath home) ~wl_home ~home () in
  let task = new_task c () in
  ignore (ok c "work_log" (`Assoc [ ("id", `String task); ("text", `String "x") ]));
  let found = ok c "work_find_sessions" (`Assoc [ ("task", `String task) ]) in
  Alcotest.(check bool) "no repo for the home directory itself" true
    (member "repo" (List.hd (items found "sessions")) = `Null);
  Alcotest.(check bool) "its name is not returned anywhere" false
    (contains (last_raw_line ()) (Filename.basename home));
  stop c

let tests =
  [
    Alcotest.test_case "control characters are refused in free text" `Quick test_controls_refused;
    Alcotest.test_case "a hand-written task of control characters is readable" `Quick test_hand_written_task_is_readable;
    Alcotest.test_case "the output bound is true at every depth" `Quick test_fit_is_a_true_bound;
    Alcotest.test_case "a cut warning is valid UTF-8" `Quick test_warning_cut_is_valid_utf8;
    Alcotest.test_case "the newest answers are kept" `Quick test_newest_answers_are_kept;
    Alcotest.test_case "work_resume shows answers among many open questions" `Quick test_resume_shows_answers_among_many_open;
    Alcotest.test_case "the path sanitiser" `Quick test_sanitiser;
    Alcotest.test_case "warnings leave no path in any form" `Quick test_warning_forms_leave_no_path;
    Alcotest.test_case "terminal escapes are removed from the output" `Quick test_terminal_escapes_are_removed;
    Alcotest.test_case "error text is sanitised, work_ask in the instructions" `Quick test_error_text_is_sanitised;
    Alcotest.test_case "an unresolved identity is reported on writes" `Quick test_identity_warning;
    Alcotest.test_case "a foreign directory fails at once" `Quick test_foreign_directory_fails_at_once;
    Alcotest.test_case "a misspelt WL_HOME does not create a chain" `Quick test_misspelt_home_does_not_create_a_chain;
    Alcotest.test_case "get_session lists its own links only" `Quick test_session_links_are_its_own;
    Alcotest.test_case "a malformed question id is reported" `Quick test_malformed_question_id_is_reported;
    Alcotest.test_case "question limits count characters" `Quick test_question_limits_count_characters;
    Alcotest.test_case "repo hides the home directory" `Quick test_repo_hides_the_home_directory;
  ]
