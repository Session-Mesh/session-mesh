(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Regression tests of the third independent review: the output shrink keeps
   the newest answers and open questions with consistent counters (S1), invalid
   UTF-8 in the data (S2), invisible and bidirectional characters (S3), notes
   cut after cleaning (M3), the path helper (M4), an orphan answer (M5), and
   the nesting guard of the stdio loop (S4). *)

open Work_client
open Work_support
module W = Mesh_worklog
module Q = Work_mcp.Work_questions
open Test_review2

let strict_utf8 text = W.Textcheck.code_points text <> None
let emoji n = String.concat "" (List.init n (fun _ -> "\xF0\x9F\x98\x80"))
let cjk n = String.concat "" (List.init n (fun _ -> "\xE4\xB8\xAD"))
let replacement = "\xEF\xBF\xBD"

(* ---- S1: the shrink order ---------------------------------------------- *)

let big_question_extra =
  [
    ("assumption", `String (emoji 1000));
    ("options", `List (List.init 8 (fun _ -> `String (cjk 100))));
  ]

let test_resume_shrink_keeps_open_and_answered () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let base = base_time () in
  for k = 0 to 9 do
    seed_question wl_home ~id:(Printf.sprintf "N-0000e%03x" k) ~ts:(base + k) ~extra:big_question_extra
      (Printf.sprintf "question %d %s" k (emoji 1990))
  done;
  for k = 0 to 3 do
    seed_answer wl_home ~id:(Printf.sprintf "N-0000e%03x" k) ~ts:(base + 100 + k) (Printf.sprintf "owner answer %d" k)
  done;
  let resume = ok c "work_resume" (`Assoc []) in
  let mine = items resume "my_questions" in
  Alcotest.(check bool) "the response was shrunk" true (member "truncated" resume = `Bool true);
  Alcotest.(check bool) "open questions are shown" true (count_of "open" mine > 0);
  Alcotest.(check bool) "an answered question is shown" true (count_of "answered" mine > 0);
  let omitted key = int_of (match member key resume with `Null -> `Int 0 | v -> v) in
  Alcotest.(check int) "open: shown plus omitted" 6 (count_of "open" mine + omitted "my_open_questions_omitted");
  Alcotest.(check int) "answered: shown plus omitted" 4
    (count_of "answered" mine + omitted "my_answered_questions_omitted");
  Alcotest.(check int) "the total counter agrees" 10 (List.length mine + omitted "my_questions_omitted");
  Alcotest.(check bool) "answered questions come after the open ones" true
    (let rec ordered seen_answered = function
       | [] -> true
       | q :: rest -> if str q "state" = "open" then (not seen_answered) && ordered false rest else ordered true rest
     in
     ordered false mine);
  stop c

let test_list_questions_shrink_keeps_newest_answers () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let base = base_time () in
  seed_question wl_home ~id:"N-0000f001" ~ts:base ~extra:big_question_extra (emoji 1990);
  for k = 1 to 7 do
    seed_answer wl_home ~id:"N-0000f001" ~ts:(base + k) (Printf.sprintf "answer %d %s" k (emoji 1980))
  done;
  let listed = ok c "work_list_questions" (`Assoc []) in
  Alcotest.(check bool) "the response was shrunk" true (member "truncated" listed = `Bool true);
  let q = List.hd (items listed "questions") in
  let numbers =
    List.map (fun a -> String.sub (str a "text") 0 8) (items q "answers")
  in
  check_str "the newest answer is kept, last" "answer 7" (List.nth numbers (List.length numbers - 1));
  Alcotest.(check int) "answers: shown plus omitted" 7 (List.length numbers + int_of (member "answers_omitted" q));
  stop c

let test_fit_answers_and_questions_directly () =
  let answers = List.init 6 (fun k -> `Assoc [ ("text", `String (Printf.sprintf "a%d %s" k (String.make 9000 'x'))) ]) in
  let json = `Assoc [ ("answers", `List answers); ("answers_omitted", `Int 2) ] in
  match Work_mcp.Work_tool.fit json with
  | None -> Alcotest.fail "must fit"
  | Some fitted ->
      let kept = items fitted "answers" in
      let last = List.nth kept (List.length kept - 1) in
      check_str "the newest answer survives" "a5" (String.sub (str last "text") 0 2);
      Alcotest.(check int) "omitted counts the older ones" (6 + 2) (List.length kept + int_of (member "answers_omitted" fitted))

(* ---- S2: invalid UTF-8 in the data ------------------------------------ *)

let rec task_files dir =
  Sys.readdir dir |> Array.to_list
  |> List.concat_map (fun name ->
         let path = Filename.concat dir name in
         if Sys.is_directory path then task_files path else [ path ])

let index_of text marker =
  let n = String.length marker in
  let rec at i = if i + n > String.length text then None else if String.sub text i n = marker then Some i else at (i + 1) in
  at 0

let replace_marker wl_home ~marker ~by =
  List.iter
    (fun path ->
      let text = read_file path in
      match index_of text marker with
      | Some i ->
          let after = String.length marker + i in
          Out_channel.with_open_bin path (fun oc ->
              output_string oc (String.sub text 0 i ^ by ^ String.sub text after (String.length text - after)))
      | None -> ())
    (task_files (Filename.concat wl_home "tasks"))

let hand_written_task c wl_home bytes =
  let id =
    W.Err.unwrap
      (W.Write_task.add (library_ctx wl_home) ~title:"H" ~product:"gateway" ~tags:[] ~links:[] ~also:[]
         ~notes:"before MARKER after" ())
  in
  replace_marker wl_home ~marker:"MARKER" ~by:bytes;
  call c "work_get" (`Assoc [ ("id", `String id) ])

let test_invalid_utf8_is_replaced () =
  with_server (fun c wl_home ->
      List.iter
        (fun (what, bytes) ->
          let r = hand_written_task c wl_home bytes in
          Alcotest.(check bool) (what ^ ": readable") false r.is_error;
          Alcotest.(check bool) (what ^ ": the whole line is valid UTF-8") true (strict_utf8 (last_raw_line ()));
          Alcotest.(check bool) (what ^ ": the text is valid UTF-8") true (strict_utf8 r.text);
          Alcotest.(check bool) (what ^ ": replaced by U+FFFD") true (contains (str r.json "notes") replacement);
          Alcotest.(check bool) (what ^ ": the rest is kept") true (contains (str r.json "notes") "after"))
        [
          ("stray 0xFF", "\xFF");
          ("truncated three-byte sequence", "\xE2\x82");
          ("truncated four-byte sequence", "\xF0\x9F\x98");
          ("overlong NUL", "\xC0\x80");
          ("overlong slash", "\xE0\x80\xAF");
          ("encoded surrogate", "\xED\xA0\x80");
          ("above U+10FFFF", "\xF4\x90\x80\x80");
          ("lone continuation byte", "\x80");
        ])

let test_clean_unit () =
  let clean = Work_mcp.Work_text.clean in
  check_str "valid text is unchanged" "h\xC3\xA9llo \xF0\x9F\x98\x80" (clean "h\xC3\xA9llo \xF0\x9F\x98\x80");
  check_str "0xFF" (replacement ^ "a") (clean "\xFFa");
  check_str "an invalid byte beside a control character" (replacement ^ "b") (clean "\xFF\001b");
  Alcotest.(check bool) "valid after cleaning" true (strict_utf8 (clean "x\xE2\x82\xC0\x80\xED\xA0\x80\xFF"))

(* ---- S3: invisible and bidirectional characters ----------------------- *)

let invisible_classes =
  [
    ("Arabic letter mark", "\xD8\x9C");
    ("left-to-right mark", "\xE2\x80\x8E");
    ("right-to-left mark", "\xE2\x80\x8F");
    ("bidi embeddings and override U+202A..U+202E", "\xE2\x80\xAA\xE2\x80\xAB\xE2\x80\xAC\xE2\x80\xAD\xE2\x80\xAE");
    ("bidi isolates U+2066..U+2069", "\xE2\x81\xA6\xE2\x81\xA7\xE2\x81\xA8\xE2\x81\xA9");
    ("line separator", "\xE2\x80\xA8");
    ("paragraph separator", "\xE2\x80\xA9");
    ("zero-width space", "\xE2\x80\x8B");
    ("byte order mark", "\xEF\xBB\xBF");
    ("word joiner", "\xE2\x81\xA0");
    ("invisible operators U+2061..U+2064", "\xE2\x81\xA1\xE2\x81\xA2\xE2\x81\xA3\xE2\x81\xA4");
    ("interlinear annotation", "\xEF\xBF\xB9\xEF\xBF\xBA\xEF\xBF\xBB");
    ("tag characters", "\xF3\xA0\x80\x81\xF3\xA0\x81\xA1\xF3\xA0\x81\xBF\xF3\xA0\x80\x80\xF3\xA0\x81\xBF");
  ]

let family = "\xF0\x9F\x91\xA8\xE2\x80\x8D\xF0\x9F\x91\xA9\xE2\x80\x8D\xF0\x9F\x91\xA7"
let zwnj = "\xE0\xA4\x95\xE2\x80\x8C\xE0\xA4\xB7"

let test_invisible_refused_on_input () =
  with_server (fun c wl_home ->
      let task = new_task c () in
      let events_before = List.length (event_lines wl_home) in
      let refused name field args =
        let r = call c name args in
        Alcotest.(check bool) (name ^ " refused") true r.is_error;
        check_str (name ^ " code") "invalid_input" (error_code r);
        Alcotest.(check bool) (name ^ " names the field " ^ field) true (contains r.text field)
      in
      List.iter
        (fun (what, chars) ->
          let text = "a" ^ chars ^ "b" in
          let add extra = `Assoc ([ ("title", `String "T"); ("product", `String "gateway") ] @ extra) in
          refused "work_add_task" "notes" (add [ ("notes", `String text) ]);
          refused "work_add_task" "tags" (add [ ("tags", `List [ `String text ]) ]);
          refused "work_log" "text" (`Assoc [ ("id", `String task); ("text", `String text) ]);
          refused "work_ask" "text" (`Assoc [ ("text", `String text) ]);
          refused "work_ask" "assumption" (`Assoc [ ("text", `String "q"); ("assumption", `String text) ]);
          refused "work_block" "text" (`Assoc [ ("id", `String task); ("text", `String text) ]);
          ignore what)
        invisible_classes;
      Alcotest.(check int) "nothing was written by a refused call" events_before (List.length (event_lines wl_home));
      let name_refused =
        Work_mcp.Work_args.reject_unsafe_text (`Assoc [ ("a\xE2\x80\xAEb", `String "x") ])
      in
      Alcotest.(check bool) "a field name is refused too" true (Result.is_error name_refused))

let test_emoji_sequences_still_accepted () =
  with_server (fun c _ ->
      let id =
        str (ok c "work_add_task" (`Assoc [ ("title", `String "E"); ("product", `String "gateway"); ("notes", `String (family ^ " " ^ zwnj)) ])) "id"
      in
      check_str "ZWJ and ZWNJ are kept" (family ^ " " ^ zwnj) (str (ok c "work_get" (`Assoc [ ("id", `String id) ])) "notes");
      Alcotest.(check bool) "a log with a ZWJ sequence is accepted" false
        (call c "work_log" (`Assoc [ ("id", `String id); ("text", `String family) ])).is_error;
      Alcotest.(check bool) "so is a question" false (call c "work_ask" (`Assoc [ ("text", `String family) ])).is_error)

let test_invisible_removed_from_output () =
  with_server (fun c wl_home ->
      List.iter
        (fun (what, chars) ->
          let r = hand_written_task c wl_home ("<" ^ chars ^ ">") in
          Alcotest.(check bool) (what ^ ": readable") false r.is_error;
          Alcotest.(check bool) (what ^ ": removed from the structured content") true
            (contains (str r.json "notes") "before <> after");
          Alcotest.(check bool) (what ^ ": removed from the text content") true (contains r.text "before <> after"))
        invisible_classes;
      let r = hand_written_task c wl_home ("<" ^ family ^ ">") in
      Alcotest.(check bool) "a ZWJ sequence in the data stays" true (contains (str r.json "notes") family))

(* ---- M3: cleaning before the cut -------------------------------------- *)

let test_notes_are_cleaned_before_the_cut () =
  with_server (fun c wl_home ->
      let r = hand_written_task c wl_home (controls 7990 ^ "visible text") in
      check_str "the text after 7990 controls is kept" "before visible text after" (str r.json "notes");
      let r = hand_written_task c wl_home (String.concat "" (List.init 3000 (fun _ -> "\xE2\x80\x8B")) ^ "kept") in
      Alcotest.(check bool) "zero-width characters do not use the bound" true (contains (str r.json "notes") "kept"))

(* ---- M4: the path helper ---------------------------------------------- *)

let test_path_helper_is_strict () =
  List.iter
    (fun s -> Alcotest.(check bool) ("a path in " ^ String.escaped s) true (has_abs_path s))
    [ "a\t/srv/x"; "a\n/srv/x"; "\xC2\xAB/srv/x"; "\xE2\x80\x98/srv/x"; "git -C/srv/x"; "a|/srv/x"; "see /9lives/x";
      "<b>/srv/x"; "a,/srv/x"; "/srv/x" ];
  List.iter
    (fun s -> Alcotest.(check bool) ("no path in " ^ String.escaped s) false (has_abs_path s))
    [ "and/or"; "https://example.invalid/a/b"; "2026/11/19"; "a / b"; "km/h"; "1/2"; "a.b/c" ]

(* ---- M5: an orphan answer is reported --------------------------------- *)

let test_orphan_answer_is_reported () =
  with_server (fun c wl_home ->
      let task = new_task c () in
      W.Err.unwrap
        (W.Txn.run (library_ctx wl_home) (fun tx ->
             W.Txn.append tx
               [ (task, "answer", [ ("question", `String "N-0badc0de"); ("text", `String "to nothing"); ("by", `String "owner") ]) ]));
      let resume = ok c "work_resume" (`Assoc []) in
      let warnings = List.map (function `String s -> s | _ -> "") (items resume "data_warnings") in
      Alcotest.(check bool) "an orphan answer is a data warning" true
        (List.exists (fun w -> contains w "answer event ignored" && contains w "N-0badc0de") warnings))

(* ---- S4: nesting guard ------------------------------------------------ *)

let nested depth = String.make depth '[' ^ String.make depth ']'

let test_too_deep_unit () =
  let deep = Work_mcp.Work_stdio.too_deep in
  Alcotest.(check bool) "at the limit" false (deep (nested Work_mcp.Work_stdio.max_nesting));
  Alcotest.(check bool) "over the limit" true (deep (nested (Work_mcp.Work_stdio.max_nesting + 1)));
  Alcotest.(check bool) "brackets in strings do not count" false (deep ("{\"a\":\"" ^ String.make 500 '[' ^ "\"}"));
  Alcotest.(check bool) "an escaped quote does not end the string" false
    (deep ("{\"a\":\"\\\"" ^ String.make 500 '[' ^ "\"}"));
  Alcotest.(check bool) "braces count" true (deep (String.make 40 '{'));
  Alcotest.(check bool) "a normal request" false
    (deep {|{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{"a":[1,{"b":[2]}]}}}|})

let test_deep_request_is_refused () =
  with_server (fun c _ ->
      let line =
        {|{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"work_list_tasks","arguments":{"product":|}
        ^ nested 2000 ^ "}}}\n"
      in
      output_string c.oc line;
      flush c.oc;
      let reply = recv c in
      check_str "refused as an invalid request" "-32600" (string_of_int (int_of (member "code" (member "error" reply))));
      Alcotest.(check bool) "the server still answers" true (items (ok c "work_list_tasks" (`Assoc [])) "tasks" = []))

let tests =
  [
    Alcotest.test_case "resume shrink keeps open and answered questions" `Quick test_resume_shrink_keeps_open_and_answered;
    Alcotest.test_case "list_questions shrink keeps the newest answers" `Quick test_list_questions_shrink_keeps_newest_answers;
    Alcotest.test_case "fit keeps the newest answers" `Quick test_fit_answers_and_questions_directly;
    Alcotest.test_case "invalid UTF-8 in a task body is replaced" `Quick test_invalid_utf8_is_replaced;
    Alcotest.test_case "clean repairs and strips" `Quick test_clean_unit;
    Alcotest.test_case "invisible characters are refused on input" `Quick test_invisible_refused_on_input;
    Alcotest.test_case "emoji ZWJ sequences are still accepted" `Quick test_emoji_sequences_still_accepted;
    Alcotest.test_case "invisible characters are removed from the output" `Quick test_invisible_removed_from_output;
    Alcotest.test_case "notes are cleaned before the cut" `Quick test_notes_are_cleaned_before_the_cut;
    Alcotest.test_case "the path helper is strict" `Quick test_path_helper_is_strict;
    Alcotest.test_case "an orphan answer is reported" `Quick test_orphan_answer_is_reported;
    Alcotest.test_case "the nesting guard" `Quick test_too_deep_unit;
    Alcotest.test_case "a deeply nested request is refused" `Quick test_deep_request_is_refused;
  ]
