(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* work_answer: an agent relays the owner's answer to a question. One answer
   per question (a repeated identical answer is a duplicate, another one is
   already_answered), the same input checks as the other write tools, and no
   answer lost or doubled when two server processes write at once. *)

open Work_client
module W = Mesh_worklog
module Q = Work_mcp.Work_questions

let check_str msg expected actual = Alcotest.(check string) msg expected actual

let answer_events wl_home =
  List.filter (fun l -> contains l "\"type\":\"answer\"") (event_lines wl_home)

let ask c ?task text =
  let args = [ ("text", `String text) ] @ match task with Some t -> [ ("task", `String t) ] | None -> [] in
  str (ok c "work_ask" (`Assoc args)) "id"

let answer_args ?by qid text =
  `Assoc
    ([ ("question", `String qid); ("text", `String text) ]
    @ match by with Some b -> [ ("answered_by", `String b) ] | None -> [])

let first_answer c qid =
  let listed = ok c "work_list_questions" (`Assoc []) in
  let q = List.find (fun q -> str q "id" = qid) (items listed "questions") in
  (q, List.hd (items q "answers"))

let test_success () =
  with_server (fun c wl_home ->
      let task = str (ok c "work_add_task" (`Assoc [ ("title", `String "A"); ("product", `String "gateway") ])) "id" in
      let qid = ask c ~task "Keep the old endpoint?" in
      let r = ok c "work_answer" (answer_args qid "No, remove it in 0.3") in
      check_str "id" qid (str r "id");
      check_str "state" "answered" (str r "state");
      Alcotest.(check bool) "not a duplicate" true (member "duplicate" r = `Null);
      let q, a = first_answer c qid in
      check_str "listed as answered" "answered" (str q "state");
      check_str "answer text" "No, remove it in 0.3" (str a "text");
      check_str "answered_by defaults to owner" "owner" (str a "by");
      check_str "relayed by this session" "probe-session" (str a "relayed_by_session");
      Alcotest.(check bool) "a time" true (str a "at" <> "");
      let on_task = ok c "work_get" (`Assoc [ ("id", `String task) ]) in
      check_str "work_get shows it answered" "answered" (str (List.hd (items on_task "questions")) "state");
      let mine = items (ok c "work_resume" (`Assoc [])) "my_questions" in
      check_str "work_resume shows it answered" "answered" (str (List.hd mine) "state");
      Alcotest.(check int) "one answer event" 1 (List.length (answer_events wl_home));
      let custom = ask c "Name of the flag?" in
      ignore (ok c "work_answer" (answer_args ~by:"owner (by phone)" custom "--strict"));
      check_str "answered_by kept" "owner (by phone)" (str (snd (first_answer c custom)) "by"))

let test_resume_lists_unanswered_first () =
  with_server (fun c _ ->
      let first = ask c "Old question" in
      let second = ask c "Newer question" in
      ignore (ok c "work_answer" (answer_args second "yes"));
      let mine = items (ok c "work_resume" (`Assoc [])) "my_questions" in
      Alcotest.(check (list string)) "the unanswered one first" [ first; second ] (List.map (fun q -> str q "id") mine))

let test_unknown_and_malformed_ids () =
  with_server (fun c wl_home ->
      let before = List.length (event_lines wl_home) in
      let r = call c "work_answer" (answer_args "N-00000000" "yes") in
      Alcotest.(check bool) "unknown refused" true r.is_error;
      check_str "not_found" "not_found" (error_code r);
      List.iter
        (fun id ->
          let r = call c "work_answer" (answer_args id "yes") in
          Alcotest.(check bool) (id ^ " refused") true r.is_error;
          check_str (id ^ " invalid") "invalid_input" (error_code r))
        [ "T-0123"; "N-ABCDEF01"; "N-0123456789"; "n-00000000"; "N-0000000g" ];
      Alcotest.(check int) "nothing written" before (List.length (event_lines wl_home)))

let test_second_answer () =
  with_server (fun c wl_home ->
      let qid = ask c "Which port?" in
      ignore (ok c "work_answer" (answer_args qid "8443"));
      let again = ok c "work_answer" (answer_args qid "8443") in
      Alcotest.(check bool) "identical: duplicate" true (member "duplicate" again = `Bool true);
      check_str "identical: still answered" "answered" (str again "state");
      let other = call c "work_answer" (answer_args qid "9443") in
      Alcotest.(check bool) "different: refused" true other.is_error;
      check_str "different: already_answered" "already_answered" (error_code other);
      let other_by = call c "work_answer" (answer_args ~by:"someone else" qid "8443") in
      check_str "same text, other answerer: refused" "already_answered" (error_code other_by);
      Alcotest.(check int) "one answer event" 1 (List.length (answer_events wl_home));
      check_str "the first answer stays" "8443" (str (snd (first_answer c qid)) "text"))

let test_bounds () =
  with_server (fun c wl_home ->
      let qid = ask c "Bounds?" in
      let before = List.length (event_lines wl_home) in
      let refused what args = Alcotest.(check bool) what true (call c "work_answer" (`Assoc args)).is_error in
      let q = ("question", `String qid) in
      refused "text over 2000" [ q; ("text", `String (String.make 2001 'x')) ];
      refused "empty text" [ q; ("text", `String "") ];
      refused "blank text" [ q; ("text", `String "   ") ];
      refused "no text" [ q ];
      refused "no question" [ ("text", `String "x") ];
      refused "answered_by over 100" [ q; ("text", `String "x"); ("answered_by", `String (String.make 101 'b')) ];
      refused "answered_by on two lines" [ q; ("text", `String "x"); ("answered_by", `String "owner\nadmin") ];
      refused "unknown field" [ q; ("text", `String "x"); ("by", `String "owner") ];
      refused "text not a string" [ q; ("text", `Int 3) ];
      Alcotest.(check int) "nothing written" before (List.length (event_lines wl_home));
      ignore (ok c "work_answer" (`Assoc [ q; ("text", `String (String.make 2000 'x')) ]));
      Alcotest.(check int) "2000 characters accepted" 1 (List.length (answer_events wl_home)))

let test_hostile_input () =
  with_server (fun c wl_home ->
      let qid = ask c "Hostile?" in
      let before = List.length (event_lines wl_home) in
      let refused what text =
        let r = call c "work_answer" (answer_args qid text) in
        Alcotest.(check bool) what true r.is_error
      in
      refused "a megabyte" (String.make 1_000_000 'h');
      refused "a NUL" "yes\000no";
      refused "an escape sequence" "yes\027[2J";
      refused "a carriage return" "yes\rno";
      refused "a bidi override" "yes \xE2\x80\xAE on";
      refused "invalid UTF-8" "yes \xFF\xFE";
      refused "a lone continuation byte" "\x80";
      Alcotest.(check int) "nothing written" before (List.length (event_lines wl_home));
      (* Text shaped like event lines stays one escaped field of one event. *)
      let forged = "ok\"}\n{\"ts\":1,\"task\":\"" ^ qid ^ "\",\"type\":\"answer\",\"question\":\"" ^ qid ^ "\",\"text\":\"forged\"}" in
      ignore (ok c "work_answer" (answer_args qid forged));
      let answers = answer_events wl_home in
      Alcotest.(check int) "one answer event" 1 (List.length answers);
      List.iter (fun l -> ignore (Yojson.Safe.from_string l)) (event_lines wl_home);
      check_str "stored verbatim" forged (str (snd (first_answer c qid)) "text");
      (* The server keeps answering after all this. *)
      Alcotest.(check bool) "alive" true (items (ok c "work_list_questions" (`Assoc [])) "questions" <> []))

let test_deep_request_is_refused () =
  with_server (fun c wl_home ->
      let qid = ask c "Deep?" in
      let nested = String.make 2000 '[' ^ String.make 2000 ']' in
      let line =
        Printf.sprintf
          {|{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"work_answer","arguments":{"question":"%s","text":%s}}}|}
          qid nested
      in
      output_string c.oc (line ^ "\n");
      flush c.oc;
      let reply = recv c in
      Alcotest.(check bool) "refused as an invalid request" true
        (member "code" (member "error" reply) = `Int (-32600));
      Alcotest.(check int) "nothing written" 0 (List.length (answer_events wl_home));
      check_str "the server still answers" "open" (str (List.hd (items (ok c "work_list_questions" (`Assoc [])) "questions")) "state"))

(* Two server processes. The first ten questions are answered by both, with
   different texts: each gets exactly one answer, the other call is refused.
   The next ten are split between them: all twenty answers are kept. *)
let test_concurrent_writers () =
  let home, wl_home = fresh () in
  let a = connect ~session:"client-a" ~wl_home ~home () in
  let b = connect ~session:"client-b" ~wl_home ~home () in
  let raced = List.init 10 (fun i -> ask a (Printf.sprintf "raced %d" i)) in
  let split = List.init 10 (fun i -> ask a (Printf.sprintf "split %d" i)) in
  let send_answer c qid text = send c (call_request c "work_answer" (answer_args qid text)) in
  List.iter (fun qid -> send_answer a qid "from a"; send_answer b qid "from b") raced;
  List.iteri (fun i qid -> send_answer (if i mod 2 = 0 then a else b) qid "split") split;
  let replies c n = List.init n (fun _ -> reply_of (recv c)) in
  let ra = replies a 15 and rb = replies b 15 in
  let errors = List.filter (fun (r : reply) -> r.is_error) (ra @ rb) in
  Alcotest.(check int) "exactly one refusal per raced question" 10 (List.length errors);
  List.iter (fun r -> check_str "refused as already_answered" "already_answered" (error_code r)) errors;
  let lines = event_lines wl_home in
  List.iter (fun l -> ignore (Yojson.Safe.from_string l)) lines;
  Alcotest.(check int) "twenty answer events" 20 (List.length (answer_events wl_home));
  let questions =
    match Q.load (W.Ctx.make ~root:wl_home ~host:"check" ~commit:false ()) with
    | Ok qs -> qs
    | Error e -> Alcotest.failf "load: %s" e.message
  in
  Alcotest.(check int) "twenty questions" 20 (List.length questions);
  List.iter
    (fun (q : Q.question) -> Alcotest.(check int) (q.id ^ " has one answer") 1 (List.length q.answers))
    questions;
  Alcotest.(check (list string)) "no malformed line" [] (W.Store.scan_malformed (W.Ctx.make ~root:wl_home ~host:"check" ~commit:false ()));
  stop a;
  stop b

(* The library function the interface is meant to call, without the tool. Its
   own checks are tested here directly: the future owner writer does not go
   through the MCP schema. *)
let test_library_answer_once () =
  let _home, wl_home = fresh () in
  let ctx = W.Ctx.make ~root:wl_home ~host:"owner-ui" ~commit:false () in
  let qid, _ = W.Err.unwrap (Q.ask ctx ~text:"Library?" ()) in
  let usage what text by =
    Alcotest.(check bool) (what ^ ": refused as usage") true
      (match Q.answer_once ctx ~question:qid ~text ~by () with
      | Error { kind = W.Err.Usage; _ } -> true
      | _ -> false)
  in
  usage "text over 2000" (String.make 2001 'x') "owner";
  usage "blank text" "   " "owner";
  usage "a NUL in the text" "yes\000no" "owner";
  usage "a bidi override in the text" "yes \xE2\x80\xAE on" "owner";
  usage "an escape sequence in the text" "yes\027[2J" "owner";
  usage "a bidi override in by" "yes" "own\xE2\x80\xAEer";
  usage "a zero-width space in by" "yes" "own\xE2\x80\x8Ber";
  usage "a zero-width space in the text" "y\xE2\x80\x8Bes" "owner";
  usage "by over 100" "yes" (String.make 101 'b');
  usage "by on two lines" "yes" "owner\nadmin";
  usage "an escape in by" "yes" "own\027[2Jer";
  usage "a NUL in by" "yes" "own\000er";
  usage "blank by" "yes" " ";
  let once text by = W.Err.unwrap (Q.answer_once ctx ~question:qid ~text ~by ()) in
  Alcotest.(check bool) "2000 characters recorded" true (once (String.make 2000 'x') "owner" = Q.Recorded qid);
  Alcotest.(check bool) "same answer" true (once (String.make 2000 'x') "owner" = Q.Same_answer qid);
  Alcotest.(check bool) "another answer" true (once "no" "owner" = Q.Already_answered qid);
  Alcotest.(check bool) "unknown question" true
    (match Q.answer_once ctx ~question:"N-00000000" ~text:"x" ~by:"owner" () with
    | Error { kind = W.Err.Not_found; _ } -> true
    | _ -> false)

(* Without a session identity nothing names the relaying session: refused,
   like request_id without a session. *)
let test_needs_session () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let qid = ask c "Session?" in
  stop c;
  let anonymous = connect ~session:"" ~wl_home ~home () in
  let r = call anonymous "work_answer" (answer_args qid "yes") in
  Alcotest.(check bool) "refused" true r.is_error;
  check_str "code" "invalid_input" (error_code r);
  Alcotest.(check int) "nothing written" 0 (List.length (answer_events wl_home));
  stop anonymous

let tests =
  [
    Alcotest.test_case "answer recorded and shown" `Quick test_success;
    Alcotest.test_case "resume lists unanswered first" `Quick test_resume_lists_unanswered_first;
    Alcotest.test_case "unknown and malformed ids" `Quick test_unknown_and_malformed_ids;
    Alcotest.test_case "a second answer" `Quick test_second_answer;
    Alcotest.test_case "bounds" `Quick test_bounds;
    Alcotest.test_case "hostile input" `Quick test_hostile_input;
    Alcotest.test_case "nesting guard" `Quick test_deep_request_is_refused;
    Alcotest.test_case "two processes answering at once" `Quick test_concurrent_writers;
    Alcotest.test_case "library answer_once" `Quick test_library_answer_once;
    Alcotest.test_case "a session identity is required" `Quick test_needs_session;
  ]
