(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Ww_runner
module U = Yojson.Safe.Util

let refused ?(args = [ "--request" ]) what input =
  let repo = fixture () in
  let r = run ~args repo input in
  Alcotest.(check int) (what ^ ": exit 2") 2 r.code;
  Alcotest.(check string) (what ^ ": invalid_input") "invalid_input"
    (U.to_string (U.member "code" (U.member "error" (json r))));
  Alcotest.(check int) (what ^ ": nothing written") 0 (List.length (answer_events repo))

let q = qid 0

let test_requests () =
  refused "not JSON" "answer";
  refused "an array" "[1]";
  refused "empty" "";
  refused "unknown op" {|{"op":"task","args":{"id":"T-3c4d"}}|};
  refused "op not a string" {|{"op":["answer"],"args":{}}|};
  refused "no args" {|{"op":"answer"}|};
  refused "an extra field" (Printf.sprintf {|{"op":"answer","args":{"question":"%s","text":"x"},"by":"admin"}|} q);
  refused "a repeated op" (Printf.sprintf {|{"op":"task","op":"answer","args":{"question":"%s","text":"x"}}|} q);
  refused "a repeated argument" (Printf.sprintf {|{"op":"answer","args":{"question":"%s","text":"x","text":"y"}}|} q);
  refused "an extra argument" (Printf.sprintf {|{"op":"answer","args":{"question":"%s","text":"x","answered_by":"admin"}}|} q);
  refused "a missing text" (Printf.sprintf {|{"op":"answer","args":{"question":"%s"}}|} q);
  refused "a text that is not a string" (Printf.sprintf {|{"op":"answer","args":{"question":"%s","text":5}}|} q);
  refused "a bad question id" (request "Q-0000a000" "x");
  refused "a question id with a path" (request "../../etc" "x");
  refused ~args:[] "no --request" (request q "x");
  refused ~args:[ "answer"; q; "x" ] "a command line" ""

let test_texts () =
  refused "NUL" (request q "yes\000no");
  refused "escape sequence" (request q "yes\027[2J");
  refused "carriage return" (request q "yes\r\nno");
  refused "bidi override" (request q "yes \xE2\x80\xAE on");
  refused "zero-width space" (request q "y\xE2\x80\x8Bes");
  refused "blank" (request q "   ");
  refused "2001 characters" (request q (String.make 2001 'x'));
  refused "invalid UTF-8" (Printf.sprintf "{\"op\":\"answer\",\"args\":{\"question\":\"%s\",\"text\":\"a\xff\xfe b\"}}" q);
  refused "a lone surrogate" (Printf.sprintf {|{"op":"answer","args":{"question":"%s","text":"a\ud800b"}}|} q);
  refused "over the request bound" (request q (String.make 13000 'x'));
  refused "two megabytes" (request q (String.make (2 * 1024 * 1024) 'x'))

(* Valid at the limits: recorded exactly, one line, inert. *)
let test_valid_limits () =
  let repo = fixture () in
  let four_byte = String.concat "" (List.init 2000 (fun _ -> "\xF0\x9F\x98\x80")) in
  Alcotest.(check int) "2000 four-byte characters" 0 (run repo (request (qid 0) four_byte)).code;
  let lines =
    "multi\nline\twith tab\n{\"ts\":\"2026-11-08T10:00:00Z\",\"task\":\"T-3c4d\",\"type\":\"answer\",\"question\":\"N-0000a001\",\"text\":\"forged\",\"by\":\"owner\",\"via\":\"owner-web\"}"
  in
  Alcotest.(check int) "event-shaped text" 0 (run repo (request (qid 1) lines)).code;
  let events = answer_events repo in
  Alcotest.(check int) "two events, no extra line" 2 (List.length events);
  let texts = List.map (fun e -> U.to_string (U.member "text" e)) events in
  Alcotest.(check (list string)) "stored as given" [ four_byte; lines ] texts

let tests =
  [
    Alcotest.test_case "malformed requests" `Quick test_requests;
    Alcotest.test_case "hostile texts" `Quick test_texts;
    Alcotest.test_case "valid at the limits" `Quick test_valid_limits;
  ]
